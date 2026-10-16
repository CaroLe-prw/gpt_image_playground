// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { useStore } from '../store'
import { cacheImage, clearImageCaches } from '../lib/imageCache'
import DetailModal from './DetailModal'

vi.mock('../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  storeImage: vi.fn(async () => 'captured-frame'),
}))

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  useStore.setState({ tasks: [], detailTaskId: null, inputImages: [], maskDraft: null })
  clearImageCaches()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

async function renderTask(patch: Partial<TaskRecord> = {}) {
  const task: TaskRecord = {
    id: 'video-task',
    prompt: '视频测试',
    params: { ...DEFAULT_PARAMS, videoDuration: 1, videoResolution: '720p' },
    mediaType: 'video',
    apiProvider: 'grok-video',
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: ['video-output'],
    status: 'done',
    error: null,
    createdAt: 1000,
    finishedAt: 188000,
    elapsed: 187000,
    ...patch,
  }
  cacheImage('video-output', 'data:video/mp4;base64,AAAAGGZ0eXBpc29tAAACAGlzb21tcDQy')
  useStore.setState({ tasks: [task], detailTaskId: task.id })
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(<DetailModal />))
  return el
}

describe('video task details', () => {
  it('shows requested and actual video duration separately from generation time', async () => {
    const el = await renderTask({ actualParamsByImage: { 'video-output': { videoDuration: 6 } } })

    expect(el.textContent).toContain('请求时长1 秒')
    expect(el.textContent).toContain('视频时长6 秒')
    expect(el.textContent).toContain('生成耗时 03:07')
    expect(el.textContent).not.toContain('透明背景')
    expect(el.textContent).not.toContain('质量')
    expect(el.textContent).not.toContain('png')
    expect(el.querySelector('[aria-label="下载视频"]')).not.toBeNull()
  })

  it('does not present requested duration as actual duration and reads the media metadata', async () => {
    const el = await renderTask()
    expect(el.textContent).toContain('视频时长未读取到')

    const video = el.querySelector('video')!
    Object.defineProperty(video, 'duration', { value: 1.25 })
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')))

    expect(el.textContent).toContain('视频时长1.25 秒')
    expect(el.textContent).toContain('请求时长1 秒')
    expect(el.textContent).toContain('生成耗时 03:07')
  })

  it('shows a useful error when an older saved output cannot play', async () => {
    const el = await renderTask()
    await act(async () => el.querySelector('video')!.dispatchEvent(new Event('error')))

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('视频无法播放')
  })

  it('keeps image parameters for image tasks', async () => {
    const el = await renderTask({ mediaType: 'image', apiProvider: 'grok' })

    expect(el.textContent).toContain('质量')
    expect(el.textContent).toContain('透明背景')
    expect(el.textContent).toContain('png')
    expect(el.textContent).not.toContain('视频时长')
  })

  it('offers to fetch the original video after a download failure', async () => {
    const el = await renderTask({
      status: 'error', error: '视频 URL 下载失败：HTTP 401', outputImages: [],
      customTaskId: 'req-existing', rawImageUrls: ['https://api.viapi.cc/v1/videos/req-existing/content'],
    })

    expect(el.querySelector('[aria-label="重新获取视频"]')).not.toBeNull()
    expect(el.querySelector('[aria-label="复制视频链接"]')).not.toBeNull()
  })

  it('shows download recovery without counting the wait as generation time', async () => {
    const el = await renderTask({
      status: 'error', error: '视频 URL 下载失败：HTTP 401', outputImages: [],
      customRecoverable: true, customTaskId: 'req-existing',
      rawImageUrls: ['https://api.viapi.cc/v1/videos/req-existing/content'],
    })

    expect(el.textContent).toContain('正在重新获取视频')
    expect(el.textContent).toContain('生成耗时 03:07')
    expect(el.textContent).not.toContain('HTTP 401')
    expect(el.querySelector('[aria-label="重新获取视频"]')).toBeNull()
  })

  it('adds the selected full video frame as a PNG reference and closes the detail dialog', async () => {
    const el = await renderTask()
    const video = el.querySelector('video')!
    Object.defineProperties(video, {
      readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 },
    })
    vi.spyOn(video, 'pause').mockImplementation(() => {})
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const png = 'data:image/png;base64,ZnJhbWU='
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png)
    const capture = [...el.querySelectorAll('button')].find((button) => button.textContent === '截取当前帧')!

    await act(async () => capture.click())

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
    expect(useStore.getState().inputImages).toEqual([{ id: 'captured-frame', dataUrl: png }])
    expect(useStore.getState().tasks[0].outputImages).toEqual(['video-output'])
    expect(useStore.getState().detailTaskId).toBeNull()
  })

  it('keeps the dialog open if the video frame is not ready', async () => {
    const el = await renderTask()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const capture = [...el.querySelectorAll('button')].find((button) => button.textContent === '截取当前帧')!

    await act(async () => capture.click())

    expect(useStore.getState().inputImages).toEqual([])
    expect(useStore.getState().detailTaskId).toBe('video-task')
    expect(useStore.getState().toast?.message).toContain('画面尚未就绪')
  })
})
