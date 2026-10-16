export function captureVideoFrame(video: HTMLVideoElement): string {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking || !video.videoWidth || !video.videoHeight) {
    throw new Error('视频画面尚未就绪，请等待加载或定位完成后再截帧。')
  }

  video.pause()
  const canvas = document.createElement('canvas')
  // 使用视频原始尺寸，不能按播放器或方形缩略图的显示尺寸裁切画面。
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持截取视频画面。')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/png')
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('视频截帧失败，请换一个画面重试。')
  return dataUrl
}
