import { useEffect, useState } from 'react'
import ActivityBar from '@/components/ActivityBar/ActivityBar'
import SidebarDock from '@/components/Sidebar/SidebarDock'
import EditorArea from '@/components/Editor/EditorArea'
import AgentPanel from '@/components/AgentPanel/AgentPanel'
import TerminalDock from '@/components/Terminal/TerminalDock'
import StatusBar from '@/components/StatusBar/StatusBar'
import Dialogs from '@/components/common/Dialogs'
import QuickPalette from '@/components/Palette/QuickPalette'
import SettingsPanel from '@/components/Settings/SettingsPanel'
import Toasts from '@/components/common/Toasts'
import TitleBar from '@/components/TitleBar/TitleBar'
import HomeScreen from '@/components/Home/HomeScreen'
import RoomPanel from '@/components/RoomPanel/RoomPanel'
import { useUiStore } from '@/stores/uiStore'
import { useThemeStore, applyTheme, onThemeChange } from '@/stores/themeStore'
import { refreshEditorTheme } from '@/highlight'
import { useEditorStore, isRestoringSession } from '@/stores/editorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useDialogStore } from '@/stores/dialogStore'
import { runCommand } from '@/commands/commands'
import { toast } from '@/stores/toastStore'
import { isBenignUnhandledRejection } from '@/utils/benignErrors'
import { exportWorkspaceDiagnostics } from '@/lsp/diagnosticsExport'
import { scheduleGitRefresh } from '@/stores/gitStore'
import { onWorkspaceChanged, onFilesChanged } from '@/services/semanticIndex'
import { useSemanticIndexStore } from '@/stores/semanticIndexStore'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { initRunStoreListeners } from '@/stores/runStore'
import { DIAGNOSTICS_GLOBAL } from '@shared/appConfig'

type DiagnosticsGetter = () => ReturnType<typeof exportWorkspaceDiagnostics>

export default function App(): JSX.Element {
  useEffect(() => {
    void useWorkspaceStore.getState().init()
  }, [])

  useEffect(() => {
    const { presetId, accent } = useThemeStore.getState()
    applyTheme(presetId, accent)
    const off = onThemeChange(() => refreshEditorTheme())
    return off
  }, [])

  useEffect(() => {
    const w = window as unknown as Record<string, DiagnosticsGetter | undefined>
    w[DIAGNOSTICS_GLOBAL] = exportWorkspaceDiagnostics
    return () => {
      delete w[DIAGNOSTICS_GLOBAL]
    }
  }, [])

  
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      toast.error(`发生错误：${e.message}`)
    }
    const onRejection = (e: PromiseRejectionEvent): void => {
      if (isBenignUnhandledRejection(e.reason)) {
        e.preventDefault()
        return
      }
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason)
      toast.error(`未处理的错误：${reason}`)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  
  useEffect(() => {
    const off = window.lc.onCloseRequest(() => {
      void useEditorStore
        .getState()
        .confirmCloseAll()
        .then((ok) => {
          if (ok) {
            useWorkspaceStore.getState().saveCurrentSession()
            window.lc.confirmClose()
          }
        })
    })
    return off
  }, [])

  
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = (): void => {
      if (isRestoringSession()) return
      clearTimeout(timer)
      timer = setTimeout(() => useWorkspaceStore.getState().saveCurrentSession(), 500)
    }
    const un1 = useEditorStore.subscribe(save)
    const un2 = useWorkspaceStore.subscribe(save)
    return () => {
      un1()
      un2()
      clearTimeout(timer)
    }
  }, [])

  
  useEffect(() => {
    const off = window.lc.onTerminalExit(({ id }) => {
      useTerminalStore.getState().removeSession(id)
    })
    return off
  }, [])

  
  useEffect(() => {
    const off = window.lc.onFsEvent(({ paths }) => {
      void useWorkspaceStore.getState().refreshTree()
      void useEditorStore.getState().reloadFromDisk(paths)
      onFilesChanged(paths)
      scheduleGitRefresh()
    })
    return off
  }, [])

  
  useEffect(() => {
    // agent 高频写文件时，每个文件都会发一次 fs:agentWrote。这里去抖批处理：
    // 攒住路径，安静 400ms 后一次性刷新文件树/重载编辑器/刷 git，避免每写一个
    // 文件就整树刷新一遍（这些刷新跑在渲染进程且原本无去抖，是 agent 改代码时的
    // 主要卡顿来源）。reloadFromDisk 本身支持批量路径。
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      timer = undefined
      if (pending.size === 0) return
      const batch = [...pending]
      pending.clear()
      void useWorkspaceStore.getState().refreshTree()
      void useEditorStore.getState().reloadFromDisk(batch)
      onFilesChanged(batch)
      scheduleGitRefresh()
    }
    const off = window.lc.onAgentWrote(({ path }) => {
      pending.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      flush()
      off()
    }
  }, [])

  
  useEffect(() => {
    const sync = (): void => {
      onWorkspaceChanged(useWorkspaceStore.getState().workspace?.path ?? null)
    }
    sync()
    return useWorkspaceStore.subscribe(sync)
  }, [])

  
  useEffect(() => {
    return window.lc.semantic.onProgress((p) => {
      useSemanticIndexStore.getState().setProgress(p)
    })
  }, [])

  useEffect(() => {
    return window.lc.knowledge.onProgress((p) => {
      useKnowledgeStore.getState().setProgress(p)
    })
  }, [])

  
  useEffect(() => {
    initRunStoreListeners()
  }, [])

  
  useEffect(() => {
    const onResize = (): void => {
      const ui = useUiStore.getState()
      const max = Math.round(window.innerHeight * 0.8)
      if (ui.terminalHeight > max) ui.setTerminalHeight(ui.terminalHeight)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  
  
  useEffect(() => {
    const off = window.lc.onMenuCommand((id) => {
      if (useDialogStore.getState().active) return
      runCommand(id)
    })
    return off
  }, [])

  // 内置浏览器打开请求（来自 agent 的 OpenInAppBrowser 工具、或 webview 内弹窗）。
  // 必须在 App 顶层注册：首页/聊天模式下 IDE 工作台尚未挂载，若监听器只存在于
  // EditorArea 则事件无人接收，浏览器标签不会打开。这里按当前视图分发到对应面板。
  useEffect(() => {
    return window.lc.onBrowserOpenUrl((url) => {
      if (useUiStore.getState().appView === 'workspace') {
        useEditorStore.getState().openBrowser(url)
      } else {
        useUiStore.getState().openHomeBrowser(url)
      }
    })
  }, [])

  const appView = useUiStore((s) => s.appView)
  // IDE 工作台首次进入后保持挂载（仅 CSS 隐藏），首页↔IDE 秒切且编辑器/终端状态保温
  const [ideMounted, setIdeMounted] = useState(false)
  useEffect(() => {
    if (appView === 'workspace' && !ideMounted) setIdeMounted(true)
  }, [appView, ideMounted])

  return (
    <div className={`app${window.lc.usesCustomTitleBar ? ' app--frameless' : ''}`}>
      {window.lc.usesCustomTitleBar && <TitleBar />}
      {appView === 'home' && <HomeScreen />}
      {appView === 'room' && <RoomPanel />}
      {ideMounted && (
        <div className={`ide-host${appView === 'workspace' ? '' : ' ide-host--hidden'}`}>
          <IdeWorkbench />
        </div>
      )}
      <Dialogs />
      <QuickPalette />
      <SettingsPanel />
      <Toasts />
    </div>
  )
}

function IdeWorkbench(): JSX.Element {
  // 首次进入 IDE 视图时激活工作区（懒加载文件树 / LSP / 监听）
  // goIde 会在切换视图前确保工作区已打开，这里只处理直接进入 IDE 视图的情况
  useEffect(() => {
    void useWorkspaceStore.getState().activateWorkspace()
  }, [])

  return (
    <>
      <div className="workbench">
        <ActivityBar />
        <SidebarDock />
        <div className="main-area">
          <EditorArea />
          <TerminalDock />
        </div>
        <AgentPanel />
      </div>
      <StatusBar />
    </>
  )
}
