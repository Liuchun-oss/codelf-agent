import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'

interface Props {
  files: ChatMessageView[]
  reviewExpanded: boolean
  onToggleReview: () => void
}


export default function ChangeBatchBar({
  files,
  reviewExpanded,
  onToggleReview
}: Props): JSX.Element | null {
  const respond = useAgentStore((s) => s.respondFileChange)

  // 单文件无需批量栏：撤销 / 取消撤销已收进每张卡片的标题行。
  if (files.length <= 1) return null

  const pending = files.filter((f) => f.fileStatus === 'proposed')
  const hasPending = pending.length > 0

  return (
    <div className="agent-change-footer">
      {hasPending && (
        <>
          <button type="button" className="agent-meta-link" onClick={() => pending.forEach((f) => respond(f.id, 'reject'))}>
            全部拒绝
          </button>
          <button type="button" className="agent-meta-link" onClick={() => pending.forEach((f) => respond(f.id, 'accept'))}>
            全部接受
          </button>
        </>
      )}
      <button type="button" className="agent-meta-link strong" onClick={onToggleReview}>
        {reviewExpanded ? '收起' : `查看 ${files.length} 个文件`}
      </button>
    </div>
  )
}
