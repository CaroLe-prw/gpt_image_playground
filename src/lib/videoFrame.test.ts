// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureVideoFrame } from './videoFrame'

afterEach(() => vi.restoreAllMocks())

describe('captureVideoFrame', () => {
  it('captures the selected frame at full native size without cropping or resizing to the preview', () => {
    const video = document.createElement('video')
    video.width = 300
    video.height = 150
    video.currentTime = 3.5
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
    })
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
    const drawImage = vi.fn()
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const png = 'data:image/png;base64,ZnJhbWU='
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png)

    expect(captureVideoFrame(video)).toBe(png)

    expect(pause).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(3.5)
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080)
    expect(context.mock.instances[0]).toMatchObject({ width: 1920, height: 1080 })
    expect(encode).toHaveBeenCalledWith('image/png')
  })

  it.each([
    { readyState: 0, seeking: false, videoWidth: 1920, videoHeight: 1080 },
    { readyState: 2, seeking: true, videoWidth: 1920, videoHeight: 1080 },
    { readyState: 2, seeking: false, videoWidth: 0, videoHeight: 0 },
  ])('rejects an unavailable or still-seeking frame', (values) => {
    const video = document.createElement('video')
    Object.defineProperties(video, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])))
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')

    expect(() => captureVideoFrame(video)).toThrow('画面尚未就绪')
    expect(context).not.toHaveBeenCalled()
  })
})
