import { usePythonStore } from '@/stores/pythonStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useEditorStore } from '@/stores/editorStore'
import { useDialogStore } from '@/stores/dialogStore'
import { BROWSER_LANGUAGES } from './runners'
import { resolveRunPlan } from './runPlan'

function isWin(): boolean {
  return window.lc.getPlatform() === 'win32'
}

function quote(p: string): string {
  if (isWin()) {
    return `'${p.replace(/'/g, "''")}'`
  }
  return `'${p.replace(/'/g, "'\\''")}'`
}

async function notify(title: string, message: string): Promise<void> {
  await useDialogStore.getState().confirm({
    title,
    message,
    confirmText: '知道了',
    cancelText: '关闭'
  })
}

/** Run the active Python file with the user-selected interpreter. */
async function runPython(path: string, isDirty: boolean): Promise<void> {
  const py = usePythonStore.getState()
  let env = py.selected
  if (!env) {
    if (!py.loaded) await py.init()
    if (py.envs.length === 0) await py.discover()
    env = usePythonStore.getState().selected
  }
  if (!env) {
    void notify('未选择 Python 环境', '请先在底部状态栏选择一个 Python 解释器。')
    return
  }
  if (isDirty) await useEditorStore.getState().saveTab(path)

  const command = isWin()
    ? `& ${quote(env.executable)} ${quote(path)}`
    : `${quote(env.executable)} ${quote(path)}`
  await useTerminalStore.getState().runCommand(command)
}

/** Open an HTML file in the system default browser. */
async function openInBrowser(path: string, isDirty: boolean): Promise<void> {
  if (isDirty) await useEditorStore.getState().saveTab(path)
  const ok = await window.lc.openExternal(path)
  if (!ok) void notify('无法打开浏览器', '系统未能用默认浏览器打开该文件。')
}

/** Run a file via the language → command runner map. */
async function runViaRunner(language: string, path: string, isDirty: boolean): Promise<void> {
  const plan = resolveRunPlan(path, language)
  if (plan.kind === 'unsupported' || !plan.command) {
    void notify('暂不支持运行', '当前文件类型还没有配置运行方式。')
    return
  }
  if (isDirty) await useEditorStore.getState().saveTab(path)
  await useTerminalStore.getState().runCommand(plan.command)
}

/** Run/preview the currently active file based on its language. */
export async function runActiveFile(): Promise<void> {
  const editor = useEditorStore.getState()
  const path = editor.activeTabPath
  const tab = editor.tabs.find((t) => t.path === path)

  if (!path || !tab || tab.kind !== 'text') {
    void notify('无法运行', '请先打开一个可运行的文件。')
    return
  }

  const lang = tab.language
  const isPy = lang === 'python' || /\.pyw?$/i.test(path)

  if (isPy) {
    await runPython(path, tab.dirty)
  } else if (BROWSER_LANGUAGES.has(lang)) {
    await openInBrowser(path, tab.dirty)
  } else {
    await runViaRunner(lang, path, tab.dirty)
  }
}
