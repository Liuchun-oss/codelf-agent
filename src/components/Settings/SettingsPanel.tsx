import { useEffect, useMemo, useState } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import AnimatedOverlay from '@/components/common/AnimatedOverlay'
import AiSettingsSection from './AiSettingsSection'
import AgentBehaviorSettingsSection from './AgentBehaviorSettingsSection'
import NetworkSettingsSection from './NetworkSettingsSection'
import WebSearchSettingsSection from './WebSearchSettingsSection'
import ImageGenSettingsSection from './ImageGenSettingsSection'
import McpSettingsSection from './McpSettingsSection'
import SkillsSettingsSection from './SkillsSettingsSection'
import PluginsSettingsSection from './PluginsSettingsSection'
import MemorySettingsSection from './MemorySettingsSection'
import KnowledgeSettingsSection from './KnowledgeSettingsSection'
import AppearanceSettingsSection from './AppearanceSettingsSection'
import EnvSettingsSection from './EnvSettingsSection'
import DebugPanelSection from './DebugPanelSection'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

type SettingsSection = 'ai' | 'editor' | 'appearance' | 'agent' | 'network' | 'websearch' | 'imagegen' | 'mcp' | 'skills' | 'plugins' | 'memory' | 'knowledge' | 'env' | 'diagnostics'

interface NavItem {
  id: SettingsSection
  title: string
  icon: JSX.Element
}

const ICON = {
  ai: (
    <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
  ),
  editor: <path d="M4 5h16M4 12h16M4 19h10" />,
  appearance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18c1.7 0 2-1.5 1-2.5s-.5-2.5 1-2.5h1.5A3.5 3.5 0 0 0 20 12a8 8 0 0 0-8-9z" />
      <circle cx="8" cy="10" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="15.5" cy="10" r="1" />
    </>
  ),
  agent: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </>
  ),
  websearch: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </>
  ),
  imagegen: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  mcp: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  skills: (
    <>
      <path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5L12 3z" />
    </>
  ),
  plugins: (
    <>
      <path d="M10 3v4M14 3v4M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v4" />
    </>
  ),
  memory: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M4 9h5M4 15h5M15 9h5M15 15h5" />
    </>
  ),
  diagnostics: <path d="M3 12h4l3 7 4-14 3 7h4" />,
  knowledge: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2z" />
      <path d="M8 7h7M8 10h7" />
    </>
  ),
  env: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18M7 14h5" />
      <circle cx="15.5" cy="14" r="0.6" fill="currentColor" />
    </>
  )
}

const NAV_ITEMS: NavItem[] = [
  { id: 'ai', title: 'AI 模型', icon: ICON.ai },
  { id: 'editor', title: '编辑器', icon: ICON.editor },
  { id: 'appearance', title: '外观', icon: ICON.appearance },
  { id: 'agent', title: 'Agent 行为', icon: ICON.agent },
  { id: 'network', title: '网络', icon: ICON.network },
  { id: 'websearch', title: '联网搜索', icon: ICON.websearch },
  { id: 'imagegen', title: '图像生成', icon: ICON.imagegen },
  { id: 'mcp', title: 'MCP 服务', icon: ICON.mcp },
  { id: 'skills', title: '技能', icon: ICON.skills },
  { id: 'plugins', title: '插件', icon: ICON.plugins },
  { id: 'memory', title: '记忆', icon: ICON.memory },
  { id: 'knowledge', title: '知识库', icon: ICON.knowledge },
  { id: 'env', title: '环境', icon: ICON.env },
  { id: 'diagnostics', title: '诊断', icon: ICON.diagnostics }
]

function EditorSettingsSection(): JSX.Element {
  const s = useSettingsStore()

  return (
    <div className="settings-section-page">
      <SettingsGroup label="排版">
        <SettingsRow
          title="字号"
          description="编辑器主字体大小，范围 8-40。"
          control={
            <input
              type="number"
              min={8}
              max={40}
              value={s.fontSize}
              onChange={(e) => s.set('fontSize', Math.max(8, Math.min(40, Number(e.target.value) || 14)))}
            />
          }
        />
        <SettingsRow
          title="缩进空格数"
          description="新缩进与格式化时使用的 tab size。"
          control={
            <select value={s.tabSize} onChange={(e) => s.set('tabSize', Number(e.target.value))}>
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="显示与保存">
        <SettingsRow
          title="自动换行"
          description="长行在可视区域内折行显示。"
          control={
            <SettingsSwitch
              checked={s.wordWrap === 'on'}
              onChange={(v) => s.set('wordWrap', v ? 'on' : 'off')}
            />
          }
        />
        <SettingsRow
          title="显示小地图"
          description="在编辑器右侧显示代码缩略导航。"
          control={<SettingsSwitch checked={s.minimap} onChange={(v) => s.set('minimap', v)} />}
        />
        <SettingsRow
          title="保存时格式化"
          description="保存文件时自动触发格式化。"
          control={<SettingsSwitch checked={s.formatOnSave} onChange={(v) => s.set('formatOnSave', v)} />}
        />
      </SettingsGroup>
    </div>
  )
}

export default function SettingsPanel(): JSX.Element | null {
  const show = useUiStore((s) => s.showSettings)
  const close = (): void => useUiStore.getState().setShowSettings(false)
  const settings = useSettingsStore()
  const [snap, setSnap] = useState(show)
  const [activeSection, setActiveSection] = useState<SettingsSection>('ai')

  useEffect(() => {
    if (show) setSnap(true)
  }, [show])

  const activeItem = useMemo(
    () => NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0],
    [activeSection]
  )

  if (!snap) return null

  return (
    <AnimatedOverlay
      open={show}
      onClose={close}
      onExited={() => setSnap(false)}
      clickOverlayToClose
      overlayClassName="modal-overlay settings-overlay"
      panelClassName="modal settings-modal"
    >
      <div className="settings-shell">
        <aside className="settings-sidebar" aria-label="设置分类">
          <div className="settings-sidebar-title">设置</div>
          <nav className="settings-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                <svg
                  className="settings-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {item.icon}
                </svg>
                <span className="settings-nav-title">{item.title}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="settings-main">
          <header className="settings-header">
            <h2>{activeItem.title}</h2>
            <button type="button" className="settings-close-btn" aria-label="关闭设置" onClick={close}>
              ×
            </button>
          </header>

          <div className="settings-content">
            {activeSection === 'ai' && <AiSettingsSection />}
            {activeSection === 'editor' && <EditorSettingsSection />}
            {activeSection === 'appearance' && <AppearanceSettingsSection />}
            {activeSection === 'agent' && <AgentBehaviorSettingsSection />}
            {activeSection === 'network' && <NetworkSettingsSection />}
            {activeSection === 'websearch' && <WebSearchSettingsSection />}
            {activeSection === 'imagegen' && <ImageGenSettingsSection />}
            {activeSection === 'mcp' && <McpSettingsSection />}
            {activeSection === 'skills' && <SkillsSettingsSection />}
            {activeSection === 'plugins' && <PluginsSettingsSection />}
            {activeSection === 'memory' && <MemorySettingsSection />}
            {activeSection === 'knowledge' && <KnowledgeSettingsSection />}
            {activeSection === 'env' && <EnvSettingsSection />}
            {activeSection === 'diagnostics' && <DebugPanelSection />}
          </div>

          <footer className="settings-footer">
            {activeSection === 'editor' && (
              <button className="btn-secondary" onClick={() => settings.reset()}>
                恢复编辑器默认
              </button>
            )}
            {activeSection === 'appearance' && (
              <button className="btn-secondary" onClick={() => useThemeStore.getState().reset()}>
                恢复默认外观
              </button>
            )}
            <button className="btn" onClick={close}>
              完成
            </button>
          </footer>
        </section>
      </div>
    </AnimatedOverlay>
  )
}
