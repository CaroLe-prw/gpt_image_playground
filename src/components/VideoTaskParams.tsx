import type { TaskParams } from '../types'

interface Props {
  params: TaskParams
  actualDuration?: number
}

export default function VideoTaskParams({ params, actualDuration }: Props) {
  const fields = [
    ['请求时长', `${params.videoDuration ?? 8} 秒`],
    ['视频时长', actualDuration != null && Number.isFinite(actualDuration) && actualDuration > 0 ? `${actualDuration} 秒` : '未读取到'],
    ['分辨率', params.videoResolution ?? '720p'],
    ['生成音频', (params.videoGenerateAudio ?? true) ? '开启' : '关闭'],
  ]

  return (
    <div className="grid grid-cols-2 gap-2 text-xs mb-4 min-w-0">
      {fields.map(([label, value]) => (
        <div key={label} className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
          <span className="text-gray-400 dark:text-gray-500">{label}</span>
          <div className="mt-0.5 font-medium text-gray-700 dark:text-gray-300">{value}</div>
        </div>
      ))}
    </div>
  )
}
