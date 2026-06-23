import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAgentStore } from '@/stores/agentStore'
import { useInlineDiffStore } from '@/stores/inlineDiffStore'
import { useInlineEditStore } from '@/stores/inlineEditStore'
import { pathToUri } from '@/lsp/uri'
import { startLspForLanguage } from '@/lsp/registry'
import { getEditorTheme, isHighlightingReady, whenHighlightingReady } from '@/highlight'
import { getEditorInstance, setEditorInstance } from './editorBridge'
import {
  registerInlineCompletionProvider,
  disposeInlineCompletionProvider,
  setInlineCompletionEnabled
} from './inlineCompletion'
import { useInlineDiff } from './useInlineDiff'
import { useInlineEditZone } from './useInlineEditZone'
import { triggerInlineEdit, acceptInlineEdit, rejectInlineEdit } from './inlineEditController'
import InlineEditWidget from './InlineEditWidget'
import TabBar from './TabBar'
import Breadcrumbs from './Breadcrumbs'
import EditorEmpty from './EditorEmpty'
import BrowserView from '@/components/common/BrowserView'
import type { EditorTab } from '@/types'

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 40
const FONT_SIZE_PERSIST_MS = 250

const EDITOR_OPTIONS = (fontSize: number, minimap: boolean, wordWrap: 'on' | 'off', tabSize: number) =>
  ({
    fontSize,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    minimap: { enabled: minimap },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap,
    tabSize,
    padding: { top: 8, bottom: 8 },
    lineNumbers: 'on' as const,
    renderWhitespace: 'selection' as const,
    bracketPairColorization: { enabled: true },
    autoClosingBrackets: 'always' as const,
    formatOnPaste: true,
    suggestOnTriggerCharacters: true,
    inlineSuggest: { enabled: true },
    'semanticHighlighting.enabled': true
  })

function bindCtrlWheelFontSize(
  host: HTMLElement,
  getEditor: () => editor.IStandaloneCodeEditor | null
): () => void {
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const flushFontSize = (ed: editor.IStandaloneCodeEditor): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    const size = ed.getRawOptions().fontSize
    if (typeof size === 'number') useSettingsStore.getState().set('fontSize', size)
  }

  const schedulePersist = (size: number): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      useSettingsStore.getState().set('fontSize', size)
    }, FONT_SIZE_PERSIST_MS)
  }

  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return
    const ed = getEditor()
    if (!ed) return
    const dom = ed.getDomNode()
    if (!dom?.contains(e.target as Node)) return
    e.preventDefault()
    e.stopPropagation()
    const cur = ed.getRawOptions().fontSize ?? useSettingsStore.getState().fontSize
    const delta = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0
    if (delta === 0) return
    const next = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, cur + delta))
    if (next === cur) return
    ed.updateOptions({ fontSize: next })
    schedulePersist(next)
  }

  host.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => {
    host.removeEventListener('wheel', onWheel, { capture: true })
    const ed = getEditor()
    if (ed) flushFontSize(ed)
  }
}

function EditorPane({ tab, isPrimary }: { tab: EditorTab; isPrimary: boolean }): JSX.Element {
  const updateTabContent = useEditorStore((s) => s.updateTabContent)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const tabSize = useSettingsStore((s) => s.tabSize)
  const wordWrap = useSettingsStore((s) => s.wordWrap)
  const minimap = useSettingsStore((s) => s.minimap)
  const revealRequest = useEditorStore((s) => s.revealRequest)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const suppressNextContentChangeRef = useRef(false)
  
  const [editorInstance, setEditorInst] = useState<Parameters<OnMount>[0] | null>(null)

  
  const diffEntry = useInlineDiffStore((s) => s.diffs.get(tab.path))
  const prevDiffRef = useRef<typeof diffEntry>(undefined)
  useInlineDiff(editorInstance, diffEntry)
  useInlineEditZone(editorInstance, tab.path)

  
  
  useEffect(() => {
    if (!editorInstance) return
    const prev = prevDiffRef.current
    prevDiffRef.current = diffEntry

    if (diffEntry && !prev) {
      const model = editorInstance.getModel()
      if (model && model.getValue() !== diffEntry.newContent) {
        suppressNextContentChangeRef.current = true
        model.setValue(diffEntry.newContent)
      }
    } else if (!diffEntry && prev) {
      
      const accepted = useInlineDiffStore.getState().consumeAccepted(tab.path)
      const model = editorInstance.getModel()
      if (accepted) {
        
        if (model && model.getValue() !== prev.newContent) {
          suppressNextContentChangeRef.current = true
          model.setValue(prev.newContent)
        }
        updateTabContent(tab.path, prev.newContent)
      } else {
        
        if (model && model.getValue() !== prev.oldContent) {
          suppressNextContentChangeRef.current = true
          model.setValue(prev.oldContent)
        }
      }
    }
  }, [diffEntry, editorInstance, tab.path, updateTabContent])

  const applyReveal = (ed: NonNullable<typeof editorRef.current>): void => {
    const req = useEditorStore.getState().revealRequest
    if (!req || req.path !== tab.path) return
    ed.revealLineInCenter(req.line)
    ed.setPosition({ lineNumber: req.line, column: req.col })
    ed.focus()
    useEditorStore.getState().clearReveal()
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    setEditorInst(editor)
    if (isPrimary) {
      setEditorInstance(editor)
      editor.onDidChangeCursorPosition((e) => {
        const { activeTabPath: cur, setCursor } = useEditorStore.getState()
        if (cur) setCursor(cur, e.position.lineNumber, e.position.column)
      })
      
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        triggerInlineEdit(editor)
      })
      
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const st = useInlineEditStore.getState()
        if (st.active && st.status === 'diff') acceptInlineEdit()
      })
      applyReveal(editor)
    }
  }

  useEffect(() => {
    return () => {
      if (isPrimary) setEditorInstance(null)
    }
  }, [isPrimary])

  useEffect(() => {
    if (!isPrimary) return
    const ed = editorRef.current
    if (!revealRequest || !ed || revealRequest.path !== tab.path) return
    ed.revealLineInCenter(revealRequest.line)
    ed.setPosition({ lineNumber: revealRequest.line, column: revealRequest.col })
    ed.focus()
    useEditorStore.getState().clearReveal()
  }, [revealRequest, tab.path, isPrimary])

  if (tab.kind === 'browser') {
    return (
      <BrowserView
        initialUrl={tab.url ?? 'https://www.bing.com'}
        onUrlChange={(url) => useEditorStore.getState().setBrowserUrl(tab.path, url)}
        onTitleChange={(title) => useEditorStore.getState().setBrowserTitle(tab.path, title)}
      />
    )
  }

  if (tab.kind === 'image') {
    return (
      <div className="image-preview">
        <img src={tab.dataUrl} alt={tab.name} />
      </div>
    )
  }

  if (tab.kind === 'diff') {
    return (
      <DiffEditor
        height="100%"
        theme={getEditorTheme()}
        language={tab.language}
        original={tab.diffOriginal ?? ''}
        modified={tab.diffModified ?? ''}
        options={{
          ...EDITOR_OPTIONS(fontSize, minimap, wordWrap, tabSize),
          readOnly: true,
          renderSideBySide: true
        }}
      />
    )
  }

  return (
    <Editor
      height="100%"
      theme={getEditorTheme()}
      path={pathToUri(tab.path)}
      language={tab.language}
      value={tab.content}
      onMount={handleMount}
      onChange={(value) => {
        if (suppressNextContentChangeRef.current) {
          suppressNextContentChangeRef.current = false
          return
        }
        updateTabContent(tab.path, value ?? '')
      }}
      options={EDITOR_OPTIONS(fontSize, minimap, wordWrap, tabSize)}
    />
  )
}

export default function EditorArea(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabPath = useEditorStore((s) => s.activeTabPath)
  const activeProfile = useAgentStore((s) => s.activeProfile)
  const editorRegionRef = useRef<HTMLDivElement>(null)

  
  useEffect(() => {
    registerInlineCompletionProvider()
    return () => disposeInlineCompletionProvider()
  }, [])

  
  useEffect(() => {
    const st = useInlineEditStore.getState()
    if (st.active && st.path && st.path !== activeTabPath) {
      
      rejectInlineEdit()
    }
  }, [activeTabPath])

  
  useEffect(() => {
    setInlineCompletionEnabled(activeProfile?.kind === 'deepseek' && activeProfile?.fimEnabled === true)
  }, [activeProfile?.kind, activeProfile?.fimEnabled])

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null

  useEffect(() => {
    const host = editorRegionRef.current
    if (!host) return
    return bindCtrlWheelFontSize(host, getEditorInstance)
  }, [])

  const [hlReady, setHlReady] = useState(() => isHighlightingReady())
  useEffect(() => {
    if (hlReady) return
    let alive = true
    void whenHighlightingReady().then(() => {
      if (alive) setHlReady(true)
    })
    return () => {
      alive = false
    }
  }, [hlReady])

  useEffect(() => {
    if (activeTab?.language) startLspForLanguage(activeTab.language)
  }, [activeTab?.language])

  return (
    <div className="editor-host">
      <TabBar />
      <Breadcrumbs />
      <div className="editor-region" ref={editorRegionRef}>
        {activeTab ? (
          !hlReady ? (
            <div className="editor-loading" />
          ) : (
            <div className="editor-split">
              <div className="editor-pane">
                <EditorPane tab={activeTab} isPrimary />
              </div>
            </div>
          )
        ) : (
          <EditorEmpty />
        )}
      </div>
      <InlineEditWidget />
    </div>
  )
}
