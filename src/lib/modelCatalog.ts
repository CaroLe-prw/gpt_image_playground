import type { ApiProfile, AppSettings } from '../types'
import { DEFAULT_GROK_BASE_URL, DEFAULT_GROK_VIDEO_BASE_URL, isOpenAICompatibleProvider } from './apiProfiles'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createGeminiAuthHeaders, getGeminiBaseUrl } from './geminiImageApi'
import { createRequestTimeoutError, getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'

const IMAGE_MODEL_PATTERN = /image|imagen|nano-banana|dall[-_]?e|flux|seedream|stable[-_]?diffusion|sdxl/i
const VIDEO_MODEL_PATTERN = /video|veo|kling|sora/i

function getModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return []
}

function readModelId(item: unknown, gemini: boolean) {
  if (gemini && item && typeof item === 'object') {
    const methods = (item as Record<string, unknown>).supportedGenerationMethods
    if (Array.isArray(methods) && !methods.includes('generateContent')) return ''
  }

  const rawId = typeof item === 'string'
    ? item
    : item && typeof item === 'object'
      ? (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name
      : ''
  if (typeof rawId !== 'string' || !rawId.trim()) return ''
  const id = rawId.trim()
  return gemini ? id.replace(/^models\//, '') : id
}

export async function fetchProfileModels(settings: AppSettings, profile: ApiProfile): Promise<string[]> {
  const gemini = profile.provider === 'gemini'
  const grok = profile.provider === 'grok'
  const grokVideo = profile.provider === 'grok-video'
  if (!gemini && !grok && !grokVideo && !isOpenAICompatibleProvider(settings, profile.provider)) {
    throw new Error('当前服务商不支持获取模型列表')
  }

  const proxyConfig = readClientDevProxyConfig()
  const defaultBaseUrl = grokVideo ? DEFAULT_GROK_VIDEO_BASE_URL : DEFAULT_GROK_BASE_URL
  const url = gemini
    ? `${getGeminiBaseUrl(profile)}/models`
    : buildApiUrl(grok || grokVideo ? profile.baseUrl.trim() || defaultBaseUrl : profile.baseUrl, 'models', proxyConfig, shouldUseApiProxy(profile.apiProxy, proxyConfig))
  const headers: Record<string, string> = gemini
    ? createGeminiAuthHeaders(profile)
    : { Authorization: `Bearer ${profile.apiKey}` }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    const response = await apiFetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))

    const ids = Array.from(new Set(getModelList(await response.json())
      .map((item) => readModelId(item, gemini))
      .filter(Boolean)))
    if (!ids.length) throw new Error('接口没有返回可用模型')
    if (gemini || grok || grokVideo || profile.apiMode === 'images') {
      const modelPattern = grokVideo ? VIDEO_MODEL_PATTERN : IMAGE_MODEL_PATTERN
      const filteredIds = ids.filter((id) => modelPattern.test(id))
      return filteredIds.length ? filteredIds : ids
    }
    return ids
  } finally {
    clearTimeout(timeoutId)
  }
}
