import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useUiStore } from '@/stores/uiStore'
import { basename } from '@/utils/path'

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case 'scanning':
      return '扫描文档…'
    case 'parsing':
      return '解析中…'
    case 'embedding':
      return '向量化中…'
    case 'done':
      return '导入完成'
    case 'error':
      return '导入失败'
    default:
      return '知识库'
  }
}

export default function KnowledgeIndexIndicator(): JSX.Element | null {
  const { active, phase, filesTotal, filesProcessed, chunksEmbedded, currentFile } = useKnowledgeStore()

  if (!active) return null

  const pct = filesTotal > 0 ? Math.min(100, Math.round((filesProcessed / filesTotal) * 100)) : 0
  const label =
    phase === 'error'
      ? '知识库导入失败'
      : phase === 'done'
        ? `已导入 ${chunksEmbedded} 块`
        : `${phaseLabel(phase)} ${filesProcessed}/${filesTotal}`

  const title = currentFile && phase !== 'done' && phase !== 'error' ? basename(currentFile) : label

  const openKnowledge = (): void => {
    useUiStore.getState().showSidebarView('knowledge')
  }

  return (
    <div
      className={`seg semantic-index knowledge-index clickable${phase === 'error' ? ' is-error' : ''}`}
      title={title}
      onClick={openKnowledge}
    >
      <span className="semantic-index__label">{label}</span>
      <span className={`semantic-index__bar${phase === 'error' ? ' is-error' : ''}`}>
        <span
          className="semantic-index__fill"
          style={{ width: phase === 'done' ? '100%' : `${pct}%` }}
        />
      </span>
      {phase !== 'done' && phase !== 'error' && (
        <button
          className="semantic-index__cancel"
          title="取消导入"
          onClick={(e) => {
            e.stopPropagation()
            void window.lc.knowledge.cancel()
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
