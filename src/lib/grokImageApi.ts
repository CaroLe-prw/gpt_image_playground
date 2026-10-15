import type { ApiProfile, ImageApiResponse, TaskParams } from '../types'
import { DEFAULT_GROK_BASE_URL, DEFAULT_GROK_MODEL } from './apiProfiles'
import { buildApiUrl } from './devProxy'
import { convertImageOutput } from './imageOutput'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  createRequestTimeoutError,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  MIME_MAP,
  normalizeBase64Image,
} from './imageApiShared'
import { apiFetch } from './platform'
import { parseRatio } from './size'

const GROK_1K_MAX_PIXELS = 1_572_864
const GROK_MAX_INPUT_IMAGES = 5
const GROK_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2']

function getGrokSizeParams(size: string) {
  const dimensions = parseRatio(size)
  if (!dimensions) return {}

  const target = dimensions.width / dimensions.height
  const aspectRatio = GROK_ASPECT_RATIOS.reduce((nearest, ratio) => {
    const [width, height] = ratio.split(':').map(Number)
    const error = Math.abs(width / height - target) / target
    if (!nearest || error < nearest.error) return { ratio, error }
    return nearest
  }, null as { ratio: string, error: number } | null)?.ratio

  return {
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    resolution: dimensions.width * dimensions.height <= GROK_1K_MAX_PIXELS ? '1k' : '2k',
  }
}

function getGrokQuality(quality: TaskParams['quality']) {
  if (quality === 'low' || quality === 'medium') return quality
  if (quality === 'high' || quality === 'xhigh' || quality === 'max') return 'medium'
  return ''
}

async function parseGrokResponse(
  payload: ImageApiResponse,
  opts: CallApiOptions,
  profile: ApiProfile,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('Grok 未返回可用图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  try {
    for (const item of data) {
      const fallbackMime = item.mime_type || MIME_MAP[opts.params.output_format] || 'image/jpeg'
      if (item.b64_json) {
        images.push(normalizeBase64Image(item.b64_json, fallbackMime))
        continue
      }
      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime, signal))
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      ;(err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('Grok 未返回可识别的图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  // 本地透明流程还要抠图，提前转成 JPEG/WebP 会放大边缘误差。
  if (opts.params.transparent_output && profile.transparentBackgroundMethod === 'local') {
    return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
  }

  return {
    images: await Promise.all(images.map((image) => convertImageOutput(image, opts.params))),
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

export async function callGrokImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Grok Imagine 不支持独立遮罩参数，请移除遮罩后改用普通参考图编辑。')
  }
  if (opts.inputImageDataUrls.length > GROK_MAX_INPUT_IMAGES) {
    throw new Error(`Grok Imagine 最多支持 ${GROK_MAX_INPUT_IMAGES} 张参考图`)
  }

  const isEdit = opts.inputImageDataUrls.length > 0
  const quality = getGrokQuality(opts.params.quality)
  const body: Record<string, unknown> = {
    model: profile.model.trim() || DEFAULT_GROK_MODEL,
    prompt: opts.prompt,
    n: Math.min(10, Math.max(1, opts.params.n || 1)),
    ...getGrokSizeParams(opts.params.size),
    ...(quality ? { quality } : {}),
    response_format: profile.responseFormatB64Json ? 'b64_json' : 'url',
  }
  if (opts.inputImageDataUrls.length === 1) {
    body.image = { url: opts.inputImageDataUrls[0], type: 'image_url' }
  } else if (isEdit) {
    body.images = opts.inputImageDataUrls.map((url) => ({ url }))
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0))
    const response = await apiFetch(buildApiUrl(profile.baseUrl.trim() || DEFAULT_GROK_BASE_URL, isEdit ? 'images/edits' : 'images/generations'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    return await parseGrokResponse(await response.json() as ImageApiResponse, opts, profile, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}
