import type { ApiProfile, AppSettings } from '../types'
import { DEFAULT_GROK_BASE_URL, isOpenAICompatibleProvider } from './apiProfiles'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createGeminiAuthHeaders, getGeminiBaseUrl } from './geminiImageApi'
import { createRequestTimeoutError, getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'

const IMAGE_MODEL_PATTERN = /image|imagen|nano-banana|dall[-_]?e|flux|seedream|stable[-_]?diffusion|sdxl/i

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
  if (!gemini && !grok && !isOpenAICompatibleProvider(settings, profile.provider)) {
    throw new Error('当前服务商不支持获取模型列表')
  }

  const proxyConfig = readClientDevProxyConfig()
  const url = gemini
    ? `${getGeminiBaseUrl(profile)}/models`
    : buildApiUrl(grok ? profile.baseUrl.trim() || DEFAULT_GROK_BASE_URL : profile.baseUrl, 'models', proxyConfig, shouldUseApiProxy(profile.apiProxy, proxyConfig))
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
    if (gemini || profile.apiMode === 'images') {
      const imageModelIds = ids.filter((id) => IMAGE_MODEL_PATTERN.test(id))
      return imageModelIds.length ? imageModelIds : ids
    }
    return ids
  } finally {
    clearTimeout(timeoutId)
  }
}
