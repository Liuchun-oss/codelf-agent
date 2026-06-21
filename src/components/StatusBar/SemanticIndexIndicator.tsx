import { useSemanticIndexStore } from '@/stores/semanticIndexStore'
import { triggerManualBuild } from '@/services/semanticIndex'

export default function SemanticIndexIndicator(): JSX.Element | null {
  const { active, phase, filesTotal, filesProcessed, needsManual, pendingFileCount } =
    useSemanticIndexStore()

  // 大仓库等待手动触发：显示可点击的“建立索引”提示。
  if (needsManual) {
    return (
      <div
        className="seg semantic-index semantic-index--manual clickable"
        title={`代码语义索引未建立（约 ${pendingFileCount} 个文件，超过自动阈值）。点击开始构建。`}
        onClick={() => triggerManualBuild()}
      >
        <span className="semantic-index__label">建立代码索引（{pendingFileCount} 文件）</span>
      </div>
    )
  }

  if (!active) return null

  const pct = filesTotal > 0 ? Math.min(100, Math.round((filesProcessed / filesTotal) * 100)) : 0
  const label =
    phase === 'error'
      ? '索引失败'
      : phase === 'done'
        ? '索引完成'
        : phase === 'scanning'
          ? '扫描代码…'
          : `索引中 ${filesProcessed}/${filesTotal}`

  return (
    <div className="seg semantic-index" title={`代码语义索引：${label}`}>
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
          title="停止索引"
          onClick={() => void window.lc.semantic.cancel()}
        >
          ✕
        </button>
      )}
    </div>
  )
}
