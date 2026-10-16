import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import {
  createDefaultGrokVideoProfile,
  DEFAULT_GROK_VIDEO_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { getGrokVideoResult } from './grokVideoApi'

// 最小 MP4 文件头，用于验证下载内容识别，不用于验证解码播放。
const MP4_HEADER = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 109, 112, 52, 50])
const VIDEO_DATA_URL = `data:video/mp4;base64,${btoa(String.fromCharCode(...MP4_HEADER))}`

function createJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createVideoResponse() {
  return new Response(MP4_HEADER, { headers: { 'Content-Type': 'video/mp4' } })
}

function createDoneResponse(url = 'https://cdn.example.com/generated.mp4') {
  return createJsonResponse({
    status: 'done',
    model: DEFAULT_GROK_VIDEO_MODEL,
    video: { url, duration: 10, respect_moderation: true },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('callGrokVideoApi', () => {
  it('submits a text-to-video request, polls it and downloads the MP4', async () => {
    const videoUrl = 'https://cdn.example.com/generated.mp4'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse({ request_id: 'req-1' }))
      .mockResolvedValueOnce(createDoneResponse(videoUrl))
      .mockResolvedValueOnce(createVideoResponse())
    const profile = createDefaultGrokVideoProfile({
      id: 'grok-video-test',
      apiKey: 'grok-key',
      baseUrl: 'https://api.viapi.cc',
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })
    const onCustomTaskEnqueued = vi.fn()

    const result = await callImageApi({
      settings,
      prompt: 'a rocket launch',
      params: {
        ...DEFAULT_PARAMS,
        size: '2560x1440',
        videoDuration: 1,
        videoResolution: '1080p',
        videoGenerateAudio: false,
      },
      inputImageDataUrls: [],
      onCustomTaskEnqueued,
    })

    expect(result.images).toEqual([VIDEO_DATA_URL])
    expect(result.actualParams?.videoDuration).toBe(10)
    expect(result.rawImageUrls).toEqual([videoUrl])
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'req-1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.viapi.cc/v1/videos/generations')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer grok-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: DEFAULT_GROK_VIDEO_MODEL,
      prompt: 'a rocket launch',
      duration: 1,
      aspect_ratio: '16:9',
      resolution: '1080p',
      generate_audio: false,
    })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.viapi.cc/v1/videos/req-1')
    expect(fetchMock.mock.calls[2][0]).toBe(videoUrl)
  })

  it('uses the input image as image-to-video input and keeps defaults', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse({ request_id: 'req-2' }))
      .mockResolvedValueOnce(createDoneResponse())
      .mockResolvedValueOnce(createVideoResponse())
    const profile = createDefaultGrokVideoProfile({ apiKey: 'grok-key', baseUrl: 'https://api.viapi.cc' })
    const dataUrl = 'data:image/png;base64,cG5n'

    await callImageApi({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: 'animate this image',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [dataUrl],
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      prompt: 'animate this image',
      duration: 8,
      resolution: '720p',
      generate_audio: true,
      image: { url: dataUrl },
    })
    expect(body).not.toHaveProperty('aspect_ratio')
  })

  it('continues polling a pending video and can resume it later', async () => {
    vi.useFakeTimers()
    const videoUrl = 'https://cdn.example.com/resumed.mp4'
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse({ status: 'pending', progress: 40 }))
      .mockResolvedValueOnce(createDoneResponse(videoUrl))
      .mockResolvedValueOnce(createVideoResponse())
    const profile = createDefaultGrokVideoProfile({ apiKey: 'grok-key', baseUrl: 'https://api.viapi.cc' })

    const promise = getGrokVideoResult(profile, 'req-resume')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.images).toEqual([VIDEO_DATA_URL])
    expect(result.rawImageUrls).toEqual([videoUrl])
  })

  it('returns failed status messages and rejects masks or extra reference images', async () => {
    const profile = createDefaultGrokVideoProfile({ apiKey: 'grok-key' })
    const dataUrl = 'data:image/png;base64,cG5n'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonResponse({
      status: 'failed',
      error: { code: 'invalid_argument', message: 'prompt blocked' },
    }))

    await expect(getGrokVideoResult(profile, 'req-failed')).rejects.toThrow('prompt blocked')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(callImageApi({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: 'masked video',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [dataUrl],
      maskDataUrl: dataUrl,
    })).rejects.toThrow('Grok 视频接口不支持独立遮罩参数')

    await expect(callImageApi({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: 'too many images',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [dataUrl, dataUrl],
    })).rejects.toThrow('Grok 视频生成最多支持 1 张参考图')

    await expect(callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'continue from a frame',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: ['data:video/mp4;base64,dmlkZW8='],
    })).rejects.toThrow('请先截取一帧图片')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['/v1/files/videos/result.mp4?token=a%2Fb', 'https://api.example.com/v1/files/videos/result.mp4?token=a%2Fb'],
    ['../files/videos/result.mp4', 'https://api.example.com/gateway/v1/files/videos/result.mp4'],
    ['result.mp4', 'https://api.example.com/gateway/v1/videos/result.mp4'],
    ['//cdn.example.com/result.mp4', 'https://cdn.example.com/result.mp4'],
    ['https://cdn.example.com/result.mp4?sig=a%2Bb', 'https://cdn.example.com/result.mp4?sig=a%2Bb'],
  ])('resolves video URL %s against the API response instead of the webpage', async (rawUrl, expectedUrl) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse(rawUrl))
      .mockResolvedValueOnce(createVideoResponse())
    const profile = createDefaultGrokVideoProfile({ apiKey: 'grok-key', baseUrl: 'https://api.example.com/gateway/v1' })

    const result = await getGrokVideoResult(profile, 'req-relative')

    expect(fetchMock.mock.calls[1][0]).toBe(expectedUrl)
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined()
    expect(result.rawImageUrls).toEqual([expectedUrl])
  })

  it('uses the final polling response URL after a redirect', async () => {
    const response = createDoneResponse('./result.mp4')
    Object.defineProperty(response, 'url', { value: 'https://media.example.com/jobs/req-1' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(createVideoResponse())

    await getGrokVideoResult(createDefaultGrokVideoProfile(), 'req-1')

    expect(fetchMock.mock.calls[1][0]).toBe('https://media.example.com/jobs/result.mp4')
  })

  it.each(['javascript:alert(1)', 'data:text/html,not-video', 'file:///tmp/video.mp4', 'https://[invalid', '   '])('rejects invalid video URL %s before downloading', async (url) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createDoneResponse(url))

    await expect(getGrokVideoResult(createDefaultGrokVideoProfile(), 'req-invalid')).rejects.toThrow(/视频.*地址/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['text/html', '<!DOCTYPE html><html><head><title>VIAPI Image</title></head><body><div id="root"></div></body></html>'],
    ['application/octet-stream', '<!DOCTYPE html><html><title>VIAPI Image</title></html>'],
    ['video/mp4', '<!DOCTYPE html><html><title>VIAPI Image</title></html>'],
    ['application/json', '{"error":"video not found"}'],
    ['video/mp4', '{"error":"video not found"}'],
    ['video/mp4', ''],
    ['video/mp4', 'not a video'],
  ])('rejects non-video content served as %s even with HTTP 200', async (type, body) => {
    const videoUrl = 'https://cdn.example.com/generated.mp4'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse(videoUrl))
      .mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': type } }))

    await expect(getGrokVideoResult(createDefaultGrokVideoProfile(), 'req-html')).rejects.toMatchObject({
      message: expect.stringContaining('不是有效的视频'),
      rawImageUrls: [videoUrl],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['application/octet-stream', 'application/mp4', ''])('recognizes MP4 bytes served with content type %s', async (type) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse())
      .mockResolvedValueOnce(new Response(MP4_HEADER, { headers: { 'Content-Type': type } }))

    const result = await getGrokVideoResult(createDefaultGrokVideoProfile(), 'req-binary')

    expect(result.images).toEqual([VIDEO_DATA_URL])
  })

  it('keeps the resolved video URL when a download fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse('/v1/files/videos/missing.mp4'))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.example.com' })

    await expect(getGrokVideoResult(profile, 'req-missing')).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 404'),
      rawImageUrls: ['https://api.example.com/v1/files/videos/missing.mp4'],
    })
  })

  it('retries a protected API video download with the profile key without generating again', async () => {
    const videoUrl = 'https://api.viapi.cc/v1/videos/req-protected/content'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse(videoUrl))
      .mockResolvedValueOnce(createJsonResponse({ code: 'API_KEY_REQUIRED' }, 401))
      .mockResolvedValueOnce(createVideoResponse())
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.viapi.cc', apiKey: 'grok-key' })

    const result = await getGrokVideoResult(profile, 'req-protected')

    expect(result.images).toEqual([VIDEO_DATA_URL])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined()
    expect(fetchMock.mock.calls[2][0]).toBe(videoUrl)
    expect(fetchMock.mock.calls[2][1]?.headers).toEqual({ Authorization: 'Bearer grok-key' })
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it.each([
    'https://cdn.example.com/video.mp4',
    'https://api.viapi.cc.other.example/video.mp4',
    'http://api.viapi.cc/v1/videos/req-1/content',
    'https://api.viapi.cc:8443/v1/videos/req-1/content',
  ])('does not send the API key to a different origin after a 401: %s', async (videoUrl) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse(videoUrl))
      .mockResolvedValueOnce(createJsonResponse({ code: 'API_KEY_REQUIRED' }, 401))
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.viapi.cc', apiKey: 'grok-key' })

    await expect(getGrokVideoResult(profile, 'req-external')).rejects.toThrow('HTTP 401')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined()
  })

  it('does not retry with credentials when the unauthenticated download redirects to a different origin', async () => {
    const denied = createJsonResponse({}, 401)
    Object.defineProperty(denied, 'url', { value: 'https://cdn.example.com/video.mp4' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse('/v1/videos/req-1/content'))
      .mockResolvedValueOnce(denied)
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.viapi.cc', apiKey: 'grok-key' })

    await expect(getGrokVideoResult(profile, 'req-1')).rejects.toThrow('HTTP 401')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops after one authenticated retry if the profile key is rejected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse('/v1/videos/req-1/content'))
      .mockResolvedValueOnce(createJsonResponse({}, 401))
      .mockResolvedValueOnce(createJsonResponse({}, 401))
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.viapi.cc', apiKey: 'bad-key' })

    await expect(getGrokVideoResult(profile, 'req-1')).rejects.toThrow('HTTP 401')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('still rejects HTML returned after authenticating a protected download', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createDoneResponse('/v1/videos/req-1/content'))
      .mockResolvedValueOnce(createJsonResponse({}, 401))
      .mockResolvedValueOnce(new Response('<!doctype html><title>VIAPI Image</title>', { headers: { 'Content-Type': 'text/html' } }))
    const profile = createDefaultGrokVideoProfile({ baseUrl: 'https://api.viapi.cc', apiKey: 'grok-key' })

    await expect(getGrokVideoResult(profile, 'req-1')).rejects.toThrow('不是有效的视频')
  })
})
