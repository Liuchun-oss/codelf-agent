import KnowledgeManager from '@/components/Knowledge/KnowledgeManager'
import ResizeHandle from '@/components/common/ResizeHandle'
import { useUiStore } from '@/stores/uiStore'

export default function KnowledgePanel(): JSX.Element {
  return (
    <div className="sidebar knowledge-sidebar">
      <div className="panel-header">
        <span>知识库</span>
      </div>
      <KnowledgeManager variant="sidebar" />
      <ResizeHandle
        edge="right"
        title="拖动调整宽度"
        getSize={() => useUiStore.getState().sidebarWidth}
        onResize={(w) => useUiStore.getState().setSidebarWidth(w)}
      />
    </div>
  )
}
