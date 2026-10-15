import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import {
  createDefaultGeminiProfile,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { callGeminiImageApi } from './geminiImageApi'

function createJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createImageResponse(data = 'aW1hZ2U=') {
  return createJsonResponse({
    candidates: [{
      content: {
        parts: [
          { text: 'generated' },
          { inlineData: { mimeType: 'image/png', data } },
        ],
      },
    }],
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('callGeminiImageApi', () => {
  it('dispatches a native Gemini request and extracts inline images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createImageResponse())
    const profile = createDefaultGeminiProfile({
      id: 'gemini-test',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    const result = await callImageApi({
      settings,
      prompt: 'a landscape',
      params: { ...DEFAULT_PARAMS, size: '2560x1440' },
      inputImageDataUrls: [],
    })

    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`)
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'gemini-key',
    })
    const body = JSON.parse(String(init?.body))
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'a landscape' }] }])
    expect(body.generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    })
  })

  it('maps reference images to inlineData and supports snake_case responses on older models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      candidates: [{
        content: {
          parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'anBlZw==' } }],
        },
      }],
    }))
    const profile = createDefaultGeminiProfile({
      apiKey: 'gemini-key',
      baseUrl: 'https://gemini-proxy.example.com',
      model: 'models/gemini-2.5-flash-image',
    })

    const result = await callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'edit these images',
      params: { ...DEFAULT_PARAMS, size: '1024x1536', output_format: 'jpeg' },
      inputImageDataUrls: [
        'data:image/png;base64,cG5n',
        'data:image/jpeg;base64,anBlZw==',
      ],
    }, profile)

    expect(result.images).toEqual(['data:image/jpeg;base64,anBlZw=='])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gemini-proxy.example.com/v1beta/models/gemini-2.5-flash-image:generateContent')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer gemini-key' })
    const body = JSON.parse(String(init?.body))
    expect(body.contents[0].parts).toEqual([
      { text: 'edit these images' },
      { inlineData: { mimeType: 'image/png', data: 'cG5n' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'anBlZw==' } },
    ])
    expect(body.generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '2:3' },
    })
  })

  it('runs multiple images concurrently and keeps partial failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createImageResponse('Zmlyc3Q='))
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'bad request' } }, 400))
    const profile = createDefaultGeminiProfile({ apiKey: 'gemini-key' })

    const result = await callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'two images',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
    }, profile)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toEqual(['data:image/png;base64,Zmlyc3Q='])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: 'bad request' }])
    expect(result.actualParams).toMatchObject({ n: 1 })
  })

  it('includes the block reason and raw payload when no image is returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
    }))
    const profile = createDefaultGeminiProfile({ apiKey: 'gemini-key' })

    await expect(callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'blocked',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, profile)).rejects.toMatchObject({
      message: 'Gemini 未返回可用图片数据（SAFETY）',
      rawResponsePayload: expect.any(String),
    })
  })

  it('rejects mask editing before sending a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = createDefaultGeminiProfile({ apiKey: 'gemini-key' })

    await expect(callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'masked edit',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,cG5n'],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    }, profile)).rejects.toThrow('Gemini 原生接口不支持独立遮罩参数')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
