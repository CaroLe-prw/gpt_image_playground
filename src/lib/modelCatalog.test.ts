import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGeminiProfile, createDefaultGrokProfile, createDefaultGrokVideoProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { fetchProfileModels } from './modelCatalog'

function createJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('fetchProfileModels', () => {
  it('requests OpenAI models and keeps image models in Images mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [
        { id: 'gpt-4o' },
        { id: 'gpt-image-2.5-sunburst' },
        { id: 'flux-pro' },
      ],
    }))
    const profile = createDefaultOpenAIProfile({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'images',
    })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual([
      'gpt-image-2.5-sunburst',
      'flux-pro',
    ])
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer test-key' },
    }))
  })

  it('keeps all models in Responses mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [{ id: 'gpt-4o' }, { id: 'gpt-image-2.5-sunburst' }],
    }))
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses' })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual([
      'gpt-4o',
      'gpt-image-2.5-sunburst',
    ])
  })

  it('falls back to the full list when no known image model name matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [{ id: 'vendor-a' }, { id: 'vendor-b' }],
    }))
    const profile = createDefaultOpenAIProfile({ apiMode: 'images' })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual(['vendor-a', 'vendor-b'])
  })

  it('requests Gemini models and normalizes native model names', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.0-flash-lite', supportedGenerationMethods: ['embedContent'] },
      ],
    }))
    const profile = createDefaultGeminiProfile({
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual([
      'gemini-3.1-flash-image',
      'gemini-nano-banana-2.1',
      'gemini-3-pro-image',
    ])
    expect(fetchMock).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/models', expect.objectContaining({
      method: 'GET',
      headers: { 'x-goog-api-key': 'gemini-key' },
    }))
  })

  it('uses Bearer authentication for Gemini-compatible custom endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      models: [{ name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] }],
    }))
    const profile = createDefaultGeminiProfile({
      baseUrl: 'https://api.viapi.cc',
      apiKey: 'gemini-key',
    })

    await fetchProfileModels(DEFAULT_SETTINGS, profile)
    expect(fetchMock).toHaveBeenCalledWith('https://api.viapi.cc/v1beta/models', expect.objectContaining({
      headers: { Authorization: 'Bearer gemini-key' },
    }))
  })

  it('requests Grok models and keeps image generation models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [
        { id: 'grok-4.3' },
        { id: 'grok-imagine-image-2.0' },
        { id: 'grok-imagine-video-1.5' },
      ],
    }))
    const profile = createDefaultGrokProfile({
      baseUrl: 'https://api.viapi.cc',
      apiKey: 'grok-key',
    })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual(['grok-imagine-image-2.0'])
    expect(fetchMock).toHaveBeenCalledWith('https://api.viapi.cc/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer grok-key' },
    }))
  })

  it('requests Grok video models and keeps video generation models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [
        { id: 'grok-imagine-image-2.0' },
        { id: 'grok-imagine-video-1.5' },
        { id: 'grok-imagine-video-1.5-lite' },
      ],
    }))
    const profile = createDefaultGrokVideoProfile({
      baseUrl: 'https://api.viapi.cc',
      apiKey: 'grok-key',
    })

    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).resolves.toEqual([
      'grok-imagine-video-1.5',
      'grok-imagine-video-1.5-lite',
    ])
    expect(fetchMock).toHaveBeenCalledWith('https://api.viapi.cc/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer grok-key' },
    }))
  })

  it('reports empty model lists and HTTP errors', async () => {
    const profile = createDefaultOpenAIProfile()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createJsonResponse({ data: [] }))
    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).rejects.toThrow('接口没有返回可用模型')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createJsonResponse({ error: { message: 'invalid key' } }, 401))
    await expect(fetchProfileModels(DEFAULT_SETTINGS, profile)).rejects.toThrow('invalid key')
  })
})
