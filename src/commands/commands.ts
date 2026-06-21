import { useEditorStore } from '@/stores/editorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useUiStore } from '@/stores/uiStore'
import { usePaletteStore } from '@/stores/paletteStore'
import { getRecentWorkspaces } from '@/utils/session'
import { formatDocument, gotoSymbol, runEditorAction } from '@/components/Editor/editorBridge'
import { buildProject } from '@/components/Editor/buildSystem'
import { triggerManualBuild } from '@/services/semanticIndex'

export interface Command {
  id: string
  title: string
  category?: string
  shortcut?: string
  
  enabled?: () => boolean
  run: () => void | Promise<void>
}


export function runCommand(id: string): void {
  const cmd = getCommands().find((c) => c.id === id)
  void cmd?.run()
}


export function getCommands(): Command[] {
  const editor = useEditorStore.getState()
  const workspace = useWorkspaceStore.getState()
  const ui = useUiStore.getState()
  const terminal = useTerminalStore.getState()
  const palette = usePaletteStore.getState()

  const hasActive = !!editor.activeTabPath
  const activeTab = editor.tabs.find((t) => t.path === editor.activeTabPath) ?? null
  const hasTextEditor = activeTab?.kind === 'text'
  const hasTabs = editor.tabs.length > 0
  const hasWorkspace = !!workspace.workspace

  const recents = getRecentWorkspaces()
    .filter((w) => w.path !== workspace.workspace?.path)
    .map<Command>((w) => ({
      id: `workspace.recent:${w.path}`,
      title: `打开最近: ${w.name}`,
      category: '文件',
      run: () => void workspace.openWorkspacePath(w)
    }))

  return [
    {
      id: 'file.new',
      title: '新建文件',
      category: '文件',
      shortcut: 'Ctrl+N',
      run: () => editor.newUntitled()
    },
    {
      id: 'workspace.open',
      title: '打开文件夹',
      category: '文件',
      shortcut: 'Ctrl+O',
      run: () => void workspace.openWorkspace()
    },
    ...recents,
    {
      id: 'workspace.close',
      title: '关闭工作区',
      category: '文件',
      enabled: () => hasWorkspace,
      run: () => workspace.closeWorkspace()
    },
    {
      id: 'workspace.refresh',
      title: '刷新资源管理器',
      category: '文件',
      enabled: () => hasWorkspace,
      run: () => void workspace.refreshTree()
    },
    {
      id: 'semantic.build',
      title: '建立 / 更新代码索引',
      category: '文件',
      enabled: () => hasWorkspace,
      run: () => triggerManualBuild()
    },
    {
      id: 'file.quickOpen',
      title: '快速打开文件…',
      category: '文件',
      shortcut: 'Ctrl+P',
      enabled: () => hasWorkspace,
      run: () => palette.open('files')
    },
    {
      id: 'view.commandPalette',
      title: '命令面板…',
      category: '视图',
      shortcut: 'Ctrl+Shift+P',
      run: () => palette.open('commands')
    },
    {
      id: 'view.explorer',
      title: '显示资源管理器',
      category: '视图',
      shortcut: 'Ctrl+Shift+E',
      run: () => ui.showSidebarView('explorer')
    },
    {
      id: 'view.search',
      title: '显示搜索',
      category: '视图',
      shortcut: 'Ctrl+Shift+F',
      run: () => ui.showSidebarView('search')
    },
    {
      id: 'view.scm',
      title: '显示源代码管理',
      category: '视图',
      shortcut: 'Ctrl+Shift+G',
      run: () => ui.showSidebarView('scm')
    },
    {
      id: 'view.knowledge',
      title: '显示知识库',
      category: '视图',
      shortcut: 'Ctrl+Shift+K',
      run: () => ui.showSidebarView('knowledge')
    },
    {
      id: 'file.save',
      title: '保存',
      category: '文件',
      shortcut: 'Ctrl+S',
      enabled: () => hasActive,
      run: () => void editor.saveActiveTab()
    },
    {
      id: 'editor.format',
      title: '格式化文档',
      category: '编辑器',
      shortcut: 'Shift+Alt+F',
      enabled: () => hasTextEditor,
      run: () => void formatDocument()
    },
    {
      id: 'editor.gotoSymbol',
      title: '转到符号…',
      category: '编辑器',
      shortcut: 'Ctrl+Shift+O',
      enabled: () => hasTextEditor,
      run: () => void gotoSymbol()
    },
    {
      id: 'editor.findReferences',
      title: '查找所有引用',
      category: '编辑器',
      shortcut: 'Shift+F12',
      enabled: () => hasTextEditor,
      run: () => void runEditorAction('editor.action.referenceSearch.trigger')
    },
    {
      id: 'editor.rename',
      title: '重命名符号',
      category: '编辑器',
      shortcut: 'F2',
      enabled: () => hasTextEditor,
      run: () => void runEditorAction('editor.action.rename')
    },
    {
      id: 'editor.close',
      title: '关闭当前标签',
      category: '编辑器',
      shortcut: 'Ctrl+W',
      enabled: () => hasActive,
      run: () => {
        const p = editor.activeTabPath
        if (p) void editor.requestCloseTab(p)
      }
    },
    {
      id: 'editor.closeAll',
      title: '关闭所有标签',
      category: '编辑器',
      enabled: () => hasTabs,
      run: () => void editor.closeAll()
    },
    {
      id: 'view.toggleSidebar',
      title: '切换资源管理器',
      category: '视图',
      shortcut: 'Ctrl+B',
      run: () => ui.toggleFileTree()
    },
    {
      id: 'view.toggleTerminal',
      title: '切换终端',
      category: '视图',
      shortcut: 'Ctrl+`',
      run: () => void terminal.toggle()
    },
    {
      id: 'view.toggleAgent',
      title: '切换 AI 面板',
      category: '视图',
      shortcut: 'Ctrl+Shift+A',
      run: () => ui.toggleAgentPanel()
    },
    {
      id: 'terminal.new',
      title: '新建终端',
      category: '终端',
      run: () => void terminal.createSession(workspace.workspace?.path)
    },
    {
      id: 'build.project',
      title: '构建项目',
      category: '运行',
      shortcut: 'Ctrl+Shift+B',
      enabled: () => hasWorkspace,
      run: () => void buildProject()
    },
    {
      id: 'view.toggleIgnoredFiles',
      title: ui.showIgnoredFiles ? '隐藏被忽略的文件' : '显示被忽略的文件',
      category: '视图',
      enabled: () => hasWorkspace,
      run: () => {
        ui.toggleShowIgnoredFiles()
        void workspace.refreshTree()
      }
    },
    {
      id: 'view.settings',
      title: '打开设置',
      category: '视图',
      run: () => ui.setShowSettings(true)
    }
  ].filter((c) => (c.enabled ? c.enabled() : true))
}
