import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'
import { MIME_MAP } from './imageApiShared'

export async function convertImageOutput(dataUrl: string, params: TaskParams) {
  const mime = MIME_MAP[params.output_format] || 'image/png'
  if (dataUrl.startsWith(`data:${mime};`)) return dataUrl

  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  if (params.output_format === 'jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(image, 0, 0)
  const quality = params.output_format !== 'png' && params.output_compression != null
    ? Math.max(0, Math.min(1, 1 - params.output_compression / 100))
    : undefined
  return canvas.toDataURL(mime, quality)
}
