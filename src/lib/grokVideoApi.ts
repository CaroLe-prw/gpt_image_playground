import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_GROK_VIDEO_BASE_URL, DEFAULT_GROK_VIDEO_MODEL } from './apiProfiles'
import { blobToDataUrl } from './dataUrl'
import { buildApiUrl } from './devProxy'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  createRequestTimeoutError,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
} from './imageApiShared'
import { apiFetch, FetchConnectError } from './platform'
import { parseRatio } from './size'

const GROK_VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']
const GROK_VIDEO_POLL_INTERVAL_MS = 5000

interface GrokVideoRequestPayload {
  request_id?: string
}

interface GrokVideoResultPayload {
  status?: string
  model?: string
  video?: {
    url?: string
    duration?: number
    respect_moderation?: boolean
  }
  error?: {
    code?: string
    message?: string
  }
}

function getGrokVideoAspectRatio(size: string) {
  const dimensions = parseRatio(size)
  if (!dimensions) return ''
  const target = dimensions.width / dimensions.height
  return GROK_VIDEO_ASPECT_RATIOS.reduce((nearest, ratio) => {
    const [width, height] = ratio.split(':').map(Number)
    const error = Math.abs(width / height - target) / target
    if (!nearest || error < nearest.error) return { ratio, error }
    return nearest
  }, null as { ratio: string, error: number } | null)?.ratio ?? ''
}

function getGrokVideoDuration(params: TaskParams) {
  const duration = Math.trunc(params.videoDuration ?? 8)
  return Math.min(15, Math.max(1, Number.isFinite(duration) ? duration : 8))
}

function getGrokVideoResolution(params: TaskParams) {
  return params.videoResolution ?? '720p'
}

function createGrokVideoError(message: string, payload: unknown) {
  const err = new Error(message)
  ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
  return err
}

function isRecoverablePollingError(err: unknown) {
  if (err instanceof FetchConnectError) return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function downloadGrokVideo(url: string, profile: ApiProfile, signal?: AbortSignal) {
  try {
    let response = await apiFetch(url, { cache: 'no-store', signal })
    const apiOrigin = new URL(buildApiUrl(profile.baseUrl.trim() || DEFAULT_GROK_VIDEO_BASE_URL, 'videos/generations')).origin
    // 公开或签名链接保持匿名；只有配置的 API 同源资源要求鉴权时才重试，避免向 CDN 发送密钥。
    if (response.status === 401 && profile.apiKey.trim() && new URL(url).origin === apiOrigin && new URL(response.url || url).origin === apiOrigin) {
      await response.body?.cancel()
      response = await apiFetch(url, {
        headers: { Authorization: `Bearer ${profile.apiKey}` },
        cache: 'no-store',
        signal,
      })
    }
    if (!response.ok) throw new Error(`视频 URL 下载失败：HTTP ${response.status}`)

    const blob = await response.blob()
    const type = blob.type.split(';')[0].trim().toLowerCase()
    const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    // 不能只相信 HTTP 200 或 Content-Type：前端回退页也可能被标为 video/mp4。
    const isMp4 = header.length >= 16 && String.fromCharCode(...header.subarray(4, 8)) === 'ftyp'
    const isVideoType = !type || type.startsWith('video/') || ['application/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(type)
    if (!isMp4 || !isVideoType) {
      throw new Error('视频下载失败：返回内容不是有效的视频文件，可能是 HTML 网页或接口错误信息，请检查视频链接和代理配置。')
    }
    return await blobToDataUrl(blob.slice(0, blob.size, 'video/mp4'))
  } catch (err) {
    if (err instanceof Error) (err as any).rawImageUrls = [url]
    throw err
  }
}

async function pollGrokVideoResult(profile: ApiProfile, requestId: string, signal?: AbortSignal): Promise<CallApiResult> {
  const url = buildApiUrl(profile.baseUrl.trim() || DEFAULT_GROK_VIDEO_BASE_URL, `videos/${encodeURIComponent(requestId)}`)
  while (true) {
    try {
      const response = await apiFetch(url, {
        headers: { Authorization: `Bearer ${profile.apiKey}` },
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(await getApiErrorMessage(response))
      const payload = await response.json() as GrokVideoResultPayload
      if (payload.status === 'failed') {
        throw createGrokVideoError(payload.error?.message || '视频生成失败', payload)
      }
      if (payload.status === 'done') {
        if (payload.video?.respect_moderation === false) throw createGrokVideoError('视频未通过内容审核', payload)
        const rawUrl = payload.video?.url
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw createGrokVideoError('视频接口未返回视频地址', payload)
        let videoUrl: string
        try {
          // 相对链接属于 API 所在站点，不能交给 fetch 按当前前端页面的地址解析。
          const resolved = new URL(rawUrl.trim(), response.url || url)
          if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') throw new Error('不支持的视频地址协议')
          videoUrl = resolved.href
        } catch {
          throw createGrokVideoError('视频接口返回了无效的视频地址，仅支持 HTTP 或 HTTPS 链接', payload)
        }
        const videoDataUrl = await downloadGrokVideo(videoUrl, profile, signal)
        const duration = payload.video?.duration
        const actualParams = {
          n: 1,
          ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { videoDuration: duration } : {}),
        }
        return {
          images: [videoDataUrl],
          rawImageUrls: [videoUrl],
          actualParams,
          actualParamsList: [actualParams],
        }
      }
    } catch (err) {
      if (!signal?.aborted && isRecoverablePollingError(err)) {
        await sleep(GROK_VIDEO_POLL_INTERVAL_MS, signal)
        continue
      }
      throw err
    }
    await sleep(GROK_VIDEO_POLL_INTERVAL_MS, signal)
  }
}

export async function getGrokVideoResult(profile: ApiProfile, requestId: string): Promise<CallApiResult> {
  return pollGrokVideoResult(profile, requestId)
}

export async function callGrokVideoApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.inputImageDataUrls.some((src) => src.startsWith('data:video/'))) throw new Error('参考图中包含视频，请先截取一帧图片再生成。')
  if (opts.maskDataUrl) throw new Error('Grok 视频接口不支持独立遮罩参数，请移除遮罩后改用普通参考图。')
  if (opts.inputImageDataUrls.length > 1) throw new Error('Grok 视频生成最多支持 1 张参考图')

  const hasInputImage = opts.inputImageDataUrls.length === 1
  const aspectRatio = hasInputImage ? '' : getGrokVideoAspectRatio(opts.params.size)
  const body: Record<string, unknown> = {
    model: profile.model.trim() || DEFAULT_GROK_VIDEO_MODEL,
    prompt: opts.prompt,
    duration: getGrokVideoDuration(opts.params),
    resolution: getGrokVideoResolution(opts.params),
    generate_audio: opts.params.videoGenerateAudio ?? true,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(hasInputImage ? { image: { url: opts.inputImageDataUrls[0] } } : {}),
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0))
    const response = await apiFetch(buildApiUrl(profile.baseUrl.trim() || DEFAULT_GROK_VIDEO_BASE_URL, 'videos/generations'), {
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
    const payload = await response.json() as GrokVideoRequestPayload
    if (!payload.request_id) throw createGrokVideoError('视频接口未返回 request_id', payload)

    opts.onCustomTaskEnqueued?.({ taskId: payload.request_id })
    return await pollGrokVideoResult(profile, payload.request_id, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}
