import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useUiStore } from '@/stores/uiStore'
import { APP_NAME } from '@shared/appConfig'
import appIcon from '@/assets/app-icon.png'

interface Shortcut {
  keys: string[]
  label: string
}

const NO_WORKSPACE_SHORTCUTS: Shortcut[] = [
  { keys: ['Ctrl', 'O'], label: '打开文件夹' },
  { keys: ['Ctrl', 'P'], label: '快速打开文件' },
  { keys: ['Ctrl', 'Shift', 'P'], label: '命令面板' }
]

const WORKSPACE_SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: '文件',
    items: [
      { keys: ['Ctrl', 'P'], label: '快速打开文件' },
      { keys: ['Ctrl', 'N'], label: '新建文件' },
      { keys: ['Ctrl', 'S'], label: '保存' },
      { keys: ['Ctrl', 'W'], label: '关闭标签' }
    ]
  },
  {
    group: '视图',
    items: [
      { keys: ['Ctrl', 'Shift', 'F'], label: '搜索' },
      { keys: ['Ctrl', 'B'], label: '资源管理器' },
      { keys: ['Ctrl', '`'], label: '终端' },
      { keys: ['Ctrl', 'Shift', 'A'], label: 'AI 面板' }
    ]
  },
  {
    group: '编辑',
    items: [
      { keys: ['Ctrl', 'Shift', 'O'], label: '转到符号' },
      { keys: ['Shift', 'Alt', 'F'], label: '格式化' },
      { keys: ['F2'], label: '重命名符号' }
    ]
  },
  {
    group: '其他',
    items: [{ keys: ['Ctrl', 'Shift', 'P'], label: '命令面板' }]
  }
]

function KeyCombo({ keys }: { keys: string[] }): JSX.Element {
  return (
    <span className="editor-empty-keys" aria-hidden>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`} className="editor-empty-keypart">
          {i > 0 && <span className="editor-empty-plus">+</span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  )
}

function ShortcutList({ items }: { items: Shortcut[] }): JSX.Element {
  return (
    <ul className="editor-empty-shortcuts">
      {items.map((s) => (
        <li key={s.label} className="editor-empty-shortcut">
          <KeyCombo keys={s.keys} />
          <span className="editor-empty-label">{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

export default function EditorEmpty(): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  if (!workspace) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-card">
          <header className="editor-empty-header">
            <img className="editor-empty-mark" src={appIcon} alt="" aria-hidden />
            <div>
              <h2 className="editor-empty-title">欢迎使用 {APP_NAME}</h2>
              <p className="editor-empty-sub">打开文件夹以开始编辑</p>
            </div>
          </header>
          <ShortcutList items={NO_WORKSPACE_SHORTCUTS} />
          <div className="editor-empty-footer">
            <button className="btn" type="button" onClick={() => void openWorkspace()}>
              打开文件夹
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => useUiStore.getState().setAppView('home')}
            >
              返回首页
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-empty">
      <div className="editor-empty-card editor-empty-card--wide">
        <header className="editor-empty-header editor-empty-header--compact">
          <div>
            <h2 className="editor-empty-title">{workspace.name}</h2>
            <p className="editor-empty-sub">从左侧选择文件，或使用快捷键</p>
          </div>
        </header>
        <div className="editor-empty-sections">
          {WORKSPACE_SHORTCUTS.map((g) => (
            <section key={g.group} className="editor-empty-section">
              <h3 className="editor-empty-section-title">{g.group}</h3>
              <ShortcutList items={g.items} />
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
