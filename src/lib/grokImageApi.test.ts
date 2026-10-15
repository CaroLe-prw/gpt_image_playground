import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import {
  createDefaultGrokProfile,
  DEFAULT_GROK_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { buildApiUrl } from './devProxy'
import { callGrokImageApi } from './grokImageApi'

function createJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createBase64Response(mimeType = 'image/png') {
  return createJsonResponse({
    data: [{ b64_json: 'aW1hZ2U=', mime_type: mimeType }],
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('callGrokImageApi', () => {
  it('dispatches a generation request with Grok size, quality and Base64 parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      data: [
        { b64_json: 'Zmlyc3Q=', mime_type: 'image/png' },
        { b64_json: 'c2Vjb25k', mime_type: 'image/png' },
      ],
    }))
    const profile = createDefaultGrokProfile({
      id: 'grok-test',
      apiKey: 'grok-key',
      baseUrl: 'https://api.viapi.cc',
      responseFormatB64Json: true,
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    const result = await callImageApi({
      settings,
      prompt: 'a landscape',
      params: { ...DEFAULT_PARAMS, n: 2, size: '2560x1440', quality: 'medium' },
      inputImageDataUrls: [],
    })

    expect(result.images).toEqual([
      'data:image/png;base64,Zmlyc3Q=',
      'data:image/png;base64,c2Vjb25k',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.viapi.cc/v1/images/generations')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer grok-key',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: DEFAULT_GROK_MODEL,
      prompt: 'a landscape',
      n: 2,
      aspect_ratio: '16:9',
      resolution: '2k',
      quality: 'medium',
      response_format: 'b64_json',
    })
    expect(body).not.toHaveProperty('size')
    expect(body).not.toHaveProperty('output_format')
    expect(body).not.toHaveProperty('moderation')
    expect(body).not.toHaveProperty('background')
  })

  it('uses image for one reference and images for multiple references', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(createBase64Response()))
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })
    const firstDataUrl = 'data:image/png;base64,Zmlyc3Q='
    const secondDataUrl = 'data:image/jpeg;base64,c2Vjb25k'

    await callGrokImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'edit one image',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [firstDataUrl],
    }, profile)
    await callGrokImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'combine images',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [firstDataUrl, secondDataUrl],
    }, profile)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(fetchMock.mock.calls[0][0]).toBe(buildApiUrl(profile.baseUrl, 'images/edits'))
    expect(firstBody.image).toEqual({ url: firstDataUrl, type: 'image_url' })
    expect(firstBody).not.toHaveProperty('images')

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(secondBody.images).toEqual([{ url: firstDataUrl }, { url: secondDataUrl }])
    expect(secondBody).not.toHaveProperty('image')
  })

  it('downloads URL responses and keeps their MIME type and raw URLs', async () => {
    const imageUrl = 'https://cdn.example.com/generated.jpg'
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse({ data: [{ url: imageUrl, mime_type: 'image/jpeg' }] }))
      .mockResolvedValueOnce(new Response(new Blob(['jpg'], { type: 'image/jpeg' })))
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })

    const result = await callGrokImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'a photo',
      params: { ...DEFAULT_PARAMS, output_format: 'jpeg' },
      inputImageDataUrls: [],
    }, profile)

    expect(result.images[0]).toBe('data:image/jpeg;base64,anBn')
    expect(result.rawImageUrls).toEqual([imageUrl])
  })

  it('rejects masks and more than five reference images before sending a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })
    const dataUrl = 'data:image/png;base64,cG5n'

    await expect(callGrokImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'masked edit',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [dataUrl],
      maskDataUrl: dataUrl,
    }, profile)).rejects.toThrow('Grok Imagine 不支持独立遮罩参数')

    await expect(callGrokImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'too many images',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: Array.from({ length: 6 }, () => dataUrl),
    }, profile)).rejects.toThrow('Grok Imagine 最多支持 5 张参考图')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
