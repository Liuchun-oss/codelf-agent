import { useEffect } from 'react'
import { useVideoQueueStore } from '@/stores/videoQueueStore'
import type { VideoTask, VideoTaskStatus } from '@shared/agentSettings'

const STATUS_LABEL: Record<VideoTaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

function StatusBadge({ status }: { status: VideoTaskStatus }): JSX.Element {
  return <span className={`video-task-badge ${status}`}>{STATUS_LABEL[status]}</span>
}

function TaskCard({ task }: { task: VideoTask }): JSX.Element {
  const cancel = useVideoQueueStore((s) => s.cancel)
  const del = useVideoQueueStore((s) => s.del)
  const active = task.status === 'queued' || task.status === 'running'

  return (
    <div className="video-task-card">
      <div className="video-task-head">
        <StatusBadge status={task.status} />
        <span className="video-task-meta">
          {task.resolution} · {task.ratio} · {task.duration}s{task.generateAudio ? ' · 有声' : ''}
        </span>
        <span className="video-task-spacer" />
        {active ? (
          <button type="button" className="video-task-btn" onClick={() => void cancel(task.id)}>
            取消
          </button>
        ) : (
          <button type="button" className="video-task-btn" onClick={() => void del(task.id)}>
            删除
          </button>
        )}
      </div>
      <div className="video-task-prompt" title={task.prompt}>
        {task.prompt}
      </div>
      {active && <div className="video-task-progress">{task.progress ?? '等待中…'}</div>}
      {task.status === 'failed' && <div className="video-task-error">{task.error ?? '生成失败'}</div>}
      {task.status === 'succeeded' && task.videoUrl && (
        <video className="video-task-video" src={task.videoUrl} controls playsInline preload="metadata" />
      )}
    </div>
  )
}

export default function VideoQueueView(): JSX.Element {
  const tasks = useVideoQueueStore((s) => s.tasks)
  const load = useVideoQueueStore((s) => s.load)
  const clearFinished = useVideoQueueStore((s) => s.clearFinished)
  const hasFinished = tasks.some((t) => t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled')

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="video-queue">
      <div className="video-queue-toolbar">
        <span className="video-queue-count">共 {tasks.length} 个任务</span>
        <span className="video-task-spacer" />
        {hasFinished && (
          <button type="button" className="video-task-btn" onClick={() => void clearFinished()}>
            清除已完成
          </button>
        )}
      </div>
      {tasks.length === 0 ? (
        <div className="video-queue-empty">暂无视频任务。在对话里让 AI 生成视频，任务会显示在这里。</div>
      ) : (
        <div className="video-queue-list">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  )
}
