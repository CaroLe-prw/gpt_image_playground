import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL } from './apiProfiles'
import { convertImageOutput } from './imageOutput'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  createRequestTimeoutError,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  mergeConcurrentApiResults,
  normalizeBase64Image,
} from './imageApiShared'
import { apiFetch } from './platform'

const GEMINI_1K_MAX_PIXELS = 1_572_864
const GEMINI_2K_MAX_PIXELS = 4_194_304
const GEMINI_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

function parseSize(size: string) {
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*(?::|x|X|×)\s*(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function getGeminiAspectRatio(size: string) {
  const dimensions = parseSize(size)
  if (!dimensions) return ''
  const target = dimensions.width / dimensions.height
  return GEMINI_ASPECT_RATIOS.reduce((nearest, ratio) => {
    const [width, height] = ratio.split(':').map(Number)
    const error = Math.abs(width / height - target) / target
    if (!nearest || error < nearest.error) return { ratio, error }
    return nearest
  }, null as { ratio: string, error: number } | null)?.ratio ?? ''
}

function getGeminiImageSize(size: string) {
  const dimensions = parseSize(size)
  if (!dimensions) return ''
  const pixels = dimensions.width * dimensions.height
  if (pixels <= GEMINI_1K_MAX_PIXELS) return '1K'
  if (pixels <= GEMINI_2K_MAX_PIXELS) return '2K'
  return '4K'
}

function supportsImageSize(model: string) {
  return !/gemini-2(?:\.|-)/i.test(model)
}

function createGenerationConfig(model: string, params: TaskParams) {
  const aspectRatio = getGeminiAspectRatio(params.size)
  const imageSize = supportsImageSize(model) ? getGeminiImageSize(params.size) : ''
  const imageConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  }
  return {
    responseModalities: ['TEXT', 'IMAGE'],
    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
  }
}

function createInlineImage(dataUrl: string) {
  if (!dataUrl.startsWith('data:')) throw new Error('参考图格式无效，应为 data URL')
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw new Error('参考图 data URL 无效')
  const metadata = dataUrl.slice(5, commaIndex)
  if (!/;base64/i.test(metadata)) throw new Error('参考图必须使用 base64 编码')
  const data = dataUrl.slice(commaIndex + 1).replace(/\s/g, '')
  if (!data) throw new Error('参考图内容为空')
  return {
    inlineData: {
      mimeType: metadata.split(';')[0] || 'image/png',
      data,
    },
  }
}

export function getGeminiBaseUrl(profile: ApiProfile) {
  const baseUrl = (profile.baseUrl.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '')
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`
    const url = new URL(withProtocol)
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1beta'
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return baseUrl
  }
}

export function createGeminiAuthHeaders(profile: ApiProfile): Record<string, string> {
  try {
    if (new URL(getGeminiBaseUrl(profile)).hostname === 'generativelanguage.googleapis.com') {
      return { 'x-goog-api-key': profile.apiKey }
    }
  } catch {
    // 无法解析的自定义地址按兼容网关处理。
  }
  // 兼容网关通常接受 Bearer，且部分网关的 CORS 预检不允许 x-goog-api-key。
  return { Authorization: `Bearer ${profile.apiKey}` }
}

function buildGeminiUrl(profile: ApiProfile) {
  const model = (profile.model.trim() || DEFAULT_GEMINI_MODEL).replace(/^models\//, '')
  return `${getGeminiBaseUrl(profile)}/models/${encodeURIComponent(model)}:generateContent`
}

function getInlineImage(part: unknown) {
  if (!part || typeof part !== 'object') return null
  const record = part as Record<string, unknown>
  const value = record.inlineData ?? record.inline_data
  if (!value || typeof value !== 'object') return null
  const inline = value as Record<string, unknown>
  if (typeof inline.data !== 'string' || !inline.data.trim()) return null
  const mime = inline.mimeType ?? inline.mime_type
  return {
    data: inline.data.trim(),
    mimeType: typeof mime === 'string' && mime.trim() ? mime : 'image/png',
  }
}

function getResponseText(payload: unknown, path: string) {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, payload)
}

function extractGeminiImages(payload: unknown) {
  const candidates = getResponseText(payload, 'candidates')
  const images: string[] = []
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const parts = getResponseText(candidate, 'content.parts')
      if (!Array.isArray(parts)) continue
      for (const part of parts) {
        const inline = getInlineImage(part)
        if (inline) images.push(normalizeBase64Image(inline.data, inline.mimeType))
      }
    }
  }
  if (images.length) return images

  const blockReason = getResponseText(payload, 'promptFeedback.blockReason')
  const finishReason = Array.isArray(candidates) ? getResponseText(candidates[0], 'finishReason') : undefined
  const reason = [blockReason, finishReason].find((value) => typeof value === 'string' && value && value !== 'STOP')
  const err = new Error(`Gemini 未返回可用图片数据${typeof reason === 'string' ? `（${reason}）` : ''}`)
  ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
  throw err
}

async function callGeminiImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0))
    const response = await apiFetch(buildGeminiUrl(profile), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...createGeminiAuthHeaders(profile),
      },
      cache: 'no-store',
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: opts.prompt },
            ...opts.inputImageDataUrls.map(createInlineImage),
          ],
        }],
        generationConfig: createGenerationConfig(profile.model, opts.params),
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))

    const payload = await response.json()
    const extractedImages = extractGeminiImages(payload)
    // 本地透明流程还要抠图，提前转成 JPEG/WebP 会放大边缘误差。
    if (opts.params.transparent_output && profile.transparentBackgroundMethod === 'local') {
      return { images: extractedImages }
    }
    return { images: await Promise.all(extractedImages.map((image) => convertImageOutput(image, opts.params))) }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callGeminiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Gemini 原生接口不支持独立遮罩参数，请移除遮罩后改用普通参考图编辑。')
  }

  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) return callGeminiImageApiSingle(opts, profile)

  const results = await Promise.allSettled(Array.from({ length: n }).map(() => callGeminiImageApiSingle({
    ...opts,
    params: { ...opts.params, n: 1 },
  }, profile)))
  return mergeConcurrentApiResults(results)
}
