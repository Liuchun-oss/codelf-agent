import { runCommand } from '@/commands/commands'
import { runEditorAction, getEditorInstance } from '@/components/Editor/editorBridge'
import { useDialogStore } from '@/stores/dialogStore'
import { useBuildStore } from '@/stores/buildStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { runBuildPlan } from '@/components/Editor/buildSystem'
import { runActiveFile } from '@/components/Editor/runFile'
import { isRunnable, BROWSER_LANGUAGES } from '@/components/Editor/runners'
import type { PopoverMenuItem } from '@/components/common/PopoverMenu'
import { APP_NAME, APP_TAGLINE } from '@shared/appConfig'

async function runMonacoOrExec(role: string, actionId?: string): Promise<void> {
  const ed = getEditorInstance()
  if (ed && actionId) {
    await runEditorAction(actionId)
    return
  }
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    document.execCommand(role)
  }
}

function cmd(id: string, label: string, shortcut?: string): PopoverMenuItem {
  return { label, shortcut, onClick: () => void runCommand(id) }
}

function edit(label: string, role: string, actionId: string, shortcut?: string): PopoverMenuItem {
  return {
    label,
    shortcut,
    onClick: () => void runMonacoOrExec(role, actionId)
  }
}

async function showAbout(): Promise<void> {
  const version = await window.lc.getAppVersion()
  await useDialogStore.getState().confirm({
    title: `关于 ${APP_NAME}`,
    message: `${APP_NAME} ${version}\n\n${APP_TAGLINE}`,
    confirmText: '确定',
    cancelText: '关闭'
  })
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** 对话模式下切到 IDE 工作台（尽力用当前会话 / 已选工作区打开）后执行回调 */
async function gotoIde(then?: () => void): Promise<void> {
  const ws = useWorkspaceStore.getState()
  const pickedWs = useUiStore.getState().homePickedWorkspace
  if (pickedWs) {
    if (ws.workspace?.path !== pickedWs.path) await ws.openWorkspacePath(pickedWs)
  } else if (!ws.workspace) {
    if (ws.lastWorkspace) {
      await ws.activateWorkspace()
    } else {
      const ag = useAgentStore.getState()
      const cwd = ag.sessions.find((m) => m.id === ag.currentSessionId)?.cwd ?? null
      if (cwd) await ws.openWorkspacePath({ path: cwd, name: basename(cwd) })
    }
  }
  useUiStore.getState().setAppView('workspace')
  then?.()
}

/** 对话模式：新建终端需要切到 IDE 工作台（终端 UI 只挂载在工作台里）后打开 */
async function newTerminalFromChat(): Promise<void> {
  await gotoIde()
  const ws = useWorkspaceStore.getState()
  await useTerminalStore.getState().createSession(ws.workspace?.path)
}

export const RUN_MENU_INDEX = 3

/** 对话模式顶部菜单：对话 / 视图 / 终端 / 帮助 */
export const CHAT_MENUS: PopoverMenuItem[][] = [
  [
    {
      label: '新建对话',
      onClick: () => {
        const ui = useUiStore.getState()
        ui.setAppView('home')
        ui.setHomeChatOpen(false)
      }
    },
    {
      label: '对话首页',
      onClick: () => useUiStore.getState().setAppView('home')
    },
    { separator: true },
    {
      label: '群聊',
      onClick: () => useUiStore.getState().setAppView('room')
    },
    {
      label: '打开 IDE 工作台',
      onClick: () => void gotoIde()
    },
    { separator: true },
    { label: '退出', onClick: () => window.lc.appQuit() }
  ],
  [
    {
      label: '切换会话侧栏',
      onClick: () => {
        const ui = useUiStore.getState()
        ui.setHomeSidebarOpen(!ui.homeSidebarOpen)
      }
    },
    {
      label: '产物预览',
      onClick: () => {
        const ui = useUiStore.getState()
        ui.setHomeArtifactOpen(!ui.homeArtifactOpen)
      }
    },
    {
      label: '内置浏览器',
      onClick: () => useUiStore.getState().openHomeBrowser()
    },
    { separator: true },
    { label: '设置', onClick: () => useUiStore.getState().setShowSettings(true) },
    { separator: true },
    { label: '重新加载', onClick: () => window.lc.appReload() },
    { label: '实际大小', onClick: () => void window.lc.appResetZoom() },
    { label: '放大', onClick: () => void window.lc.appZoomIn() },
    { label: '缩小', onClick: () => void window.lc.appZoomOut() },
    { label: '全屏', onClick: () => void window.lc.appToggleFullscreen() }
  ],
  [
    { label: '新建终端', onClick: () => void newTerminalFromChat() },
    { label: '在 IDE 中打开终端', onClick: () => void gotoIde(() => void useTerminalStore.getState().toggle()) }
  ],
  [{ label: `关于 ${APP_NAME}`, onClick: () => void showAbout() }]
]


export const APP_MENUS: PopoverMenuItem[][] = [
  [
    cmd('file.new', '新建文件', 'Ctrl+N'),
    cmd('workspace.open', '打开文件夹…', 'Ctrl+O'),
    cmd('workspace.close', '关闭工作区'),
    { separator: true },
    cmd('semantic.build', '建立 / 更新代码索引'),
    { separator: true },
    cmd('file.quickOpen', '快速打开文件…', 'Ctrl+P'),
    { separator: true },
    cmd('file.save', '保存', 'Ctrl+S'),
    { separator: true },
    cmd('editor.close', '关闭标签', 'Ctrl+W'),
    { separator: true },
    { label: '退出', onClick: () => window.lc.appQuit() }
  ],
  [
    edit('撤销', 'undo', 'editor.action.undo', 'Ctrl+Z'),
    edit('重做', 'redo', 'editor.action.redo', 'Ctrl+Y'),
    { separator: true },
    edit('剪切', 'cut', 'editor.action.clipboardCutAction', 'Ctrl+X'),
    edit('复制', 'copy', 'editor.action.clipboardCopyAction', 'Ctrl+C'),
    edit('粘贴', 'paste', 'editor.action.clipboardPasteAction', 'Ctrl+V'),
    edit('全选', 'selectAll', 'editor.action.selectAll', 'Ctrl+A'),
    { separator: true },
    cmd('editor.format', '格式化文档', 'Shift+Alt+F'),
    cmd('editor.rename', '重命名符号', 'F2'),
    cmd('editor.findReferences', '查找所有引用', 'Shift+F12')
  ],
  [
    cmd('view.commandPalette', '命令面板…', 'Ctrl+Shift+P'),
    { separator: true },
    cmd('view.explorer', '资源管理器', 'Ctrl+Shift+E'),
    cmd('view.search', '搜索', 'Ctrl+Shift+F'),
    cmd('view.scm', '源代码管理', 'Ctrl+Shift+G'),
    cmd('view.knowledge', '知识库', 'Ctrl+Shift+K'),
    cmd('view.toggleSidebar', '切换侧边栏', 'Ctrl+B'),
    cmd('view.toggleTerminal', '切换终端', 'Ctrl+`'),
    cmd('view.toggleAgent', '切换 AI 面板', 'Ctrl+Shift+A'),
    { separator: true },
    cmd('editor.gotoSymbol', '转到符号…', 'Ctrl+Shift+O'),
    { separator: true },
    cmd('view.settings', '设置'),
    { separator: true },
    { label: '重新加载', onClick: () => window.lc.appReload() },
    { label: '实际大小', onClick: () => void window.lc.appResetZoom() },
    { label: '放大', onClick: () => void window.lc.appZoomIn() },
    { label: '缩小', onClick: () => void window.lc.appZoomOut() },
    { label: '全屏', onClick: () => void window.lc.appToggleFullscreen() }
  ],
  [cmd('build.project', '构建项目…', 'Ctrl+Shift+B')],
  [cmd('terminal.new', '新建终端')],
  [{ label: `关于 ${APP_NAME}`, onClick: () => void showAbout() }]
]


function activeRunItem(): PopoverMenuItem | null {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find((t) => t.path === editor.activeTabPath)
  if (!tab || tab.kind !== 'text' || !isRunnable(tab.language, tab.path)) return null
  const isBrowser = BROWSER_LANGUAGES.has(tab.language)
  const verb = isBrowser ? '在浏览器中打开' : '运行'
  return {
    label: `${verb} ${tab.name}`,
    onClick: () => void runActiveFile()
  }
}

export function getRunMenuItems(): PopoverMenuItem[] {
  const items: PopoverMenuItem[] = []

  
  const runItem = activeRunItem()
  if (runItem) {
    items.push(runItem)
    items.push({ separator: true })
  }

  const { plans } = useBuildStore.getState()
  if (plans.length === 0) {
    items.push({ label: '（未检测到可用的构建配置）', disabled: true })
    return items
  }
  
  const builds = plans.filter((p) => !p.id.includes('install'))
  const installs = plans.filter((p) => p.id.includes('install'))
  for (const p of builds) {
    items.push({ label: p.label, onClick: () => void runBuildPlan(p) })
  }
  if (installs.length > 0) {
    items.push({ separator: true })
    for (const p of installs) {
      items.push({ label: p.label, onClick: () => void runBuildPlan(p) })
    }
  }
  return items
}
