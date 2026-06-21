import { useEditorStore } from '@/stores/editorStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import type { FileEncoding } from '@/types'
import { APP_NAME } from '@shared/appConfig'
import { useAppVersion } from '@/hooks/useAppVersion'
import PythonEnvPicker from './PythonEnvPicker'
import SemanticIndexIndicator from './SemanticIndexIndicator'
import KnowledgeIndexIndicator from './KnowledgeIndexIndicator'

const ENCODING_LABEL: Record<FileEncoding, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE'
}

function formatSize(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export default function StatusBar(): JSX.Element {
  const { tabs, activeTabPath } = useEditorStore()
  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null

  const showFileTree = useUiStore((s) => s.showFileTree)
  const showAgentPanel = useUiStore((s) => s.showAgentPanel)
  const showTerminal = useUiStore((s) => s.showTerminal)
  const toggleFileTree = useUiStore((s) => s.toggleFileTree)
  const toggleAgentPanel = useUiStore((s) => s.toggleAgentPanel)
  const activeProfile = useAgentStore((s) => s.activeProfile)

  const isPython =
    activeTab?.kind === 'text' &&
    (activeTab.language === 'python' || /\.pyw?$/i.test(activeTab.path))

  const appVersion = useAppVersion()

  return (
    <div className="statusbar">
      <div className="seg" title={appVersion ? `${APP_NAME} v${appVersion}` : APP_NAME}>
        {APP_NAME}
        {appVersion && <span className="statusbar-version">v{appVersion}</span>}
      </div>
      <button
        type="button"
        className={`seg clickable${showFileTree ? ' on' : ''}`}
        title="切换资源管理器 (Ctrl+B)"
        onClick={toggleFileTree}
      >
        资源管理器
      </button>
      <button
        type="button"
        className={`seg clickable${showTerminal ? ' on' : ''}`}
        title="切换终端 (Ctrl+`)"
        onClick={() => void useTerminalStore.getState().toggle()}
      >
        终端
      </button>
      <button
        type="button"
        className={`seg clickable${showAgentPanel ? ' on' : ''}`}
        title="切换 AI 面板 (Ctrl+Shift+A)"
        onClick={toggleAgentPanel}
      >
        AI 面板
      </button>
      <div className="spacer" />
      <KnowledgeIndexIndicator />
      <SemanticIndexIndicator />
      {activeTab && (
        <>
          <div className="seg">{activeTab.name}</div>
          {activeTab.kind === 'text' ? (
            <>
              <div className="seg">{ENCODING_LABEL[activeTab.encoding ?? 'utf8']}</div>
              <div className="seg">{activeTab.language}</div>
              <div className="seg">
                Ln {activeTab.cursorLine ?? 1}, Col {activeTab.cursorCol ?? 1}
              </div>
            </>
          ) : (
            <div className="seg">图片 {formatSize(activeTab.size)}</div>
          )}
        </>
      )}
      {isPython && <PythonEnvPicker />}
      <div
        className="seg clickable"
        title={activeProfile ? `AI: ${activeProfile.name} · ${activeProfile.model} — 点击打开设置` : '设置'}
        onClick={() => useUiStore.getState().setShowSettings(true)}
      >
        ⚙
      </div>
    </div>
  )
}
