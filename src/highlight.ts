import * as monaco from 'monaco-editor'
import { createHighlighter, type Highlighter } from 'shiki'
import { shikiToMonaco, textmateThemeToMonacoTheme } from '@shikijs/monaco'
import { cssVar, isLightPreset } from '@/stores/themeStore'


/** Shiki theme names; also used directly as the Monaco theme ids, since
 *  @shikijs/monaco hijacks monaco.editor.setTheme to only accept loaded
 *  Shiki theme names. */
const SHIKI_DARK = 'dark-plus'
const SHIKI_LIGHT = 'light-plus'

/** Shiki theme name matching the active app theme (light vs dark). */
function activeShikiTheme(): string {
  return isLightPreset() ? SHIKI_LIGHT : SHIKI_DARK
}

const SHIKI_LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'html',
  'css',
  'scss',
  'less',
  'vue',
  'json',
  'python',
  'java',
  'go',
  'rust',
  'ruby',
  'php',
  'csharp',
  'c',
  'cpp',
  'kotlin',
  'swift',
  'dart',
  'scala',
  'groovy',
  'lua',
  'perl',
  'r',
  'shellscript',
  'powershell',
  'bat',
  'yaml',
  'toml',
  'ini',
  'docker',
  'sql',
  'xml',
  'markdown',
  'graphql',
  'diff'
]

const CUSTOM_LANGS = ['tsx', 'jsx', 'toml', 'vue', 'graphql', 'diff', 'dockerfile']

const TS_LIKE_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '`', close: '`', notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '`', close: '`' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '<', close: '>' }
  ],
  autoCloseBefore: ';:.,=}])>` \n\t',
  
  wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  folding: {
    markers: {
      start: /^\s*\/\/\s*#?region\b/,
      end: /^\s*\/\/\s*#?endregion\b/
    }
  }
}

const ownedLanguages = new Set<string>()
let lockActive = false

let readyPromise: Promise<void> | null = null
let loaded = false
let shikiOk = false
let highlighter: Highlighter | null = null

const VS_DARK_PLUS_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: 'namespace', foreground: '4EC9B0' },
  { token: 'type', foreground: '4EC9B0' },
  { token: 'class', foreground: '4EC9B0' },
  { token: 'enum', foreground: '4EC9B0' },
  { token: 'interface', foreground: '4EC9B0' },
  { token: 'struct', foreground: '4EC9B0' },
  { token: 'typeParameter', foreground: '4EC9B0' },
  { token: 'parameter', foreground: '9CDCFE' },
  { token: 'variable', foreground: '9CDCFE' },
  { token: 'property', foreground: '9CDCFE' },
  { token: 'enumMember', foreground: '4FC1FF' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'method', foreground: 'DCDCAA' },
  { token: 'macro', foreground: 'DCDCAA' },
  { token: 'decorator', foreground: 'DCDCAA' },
  { token: 'variable.readonly', foreground: '4FC1FF' },
  { token: 'property.readonly', foreground: '4FC1FF' },
  
  
  { token: 'class.declaration', foreground: '4EC9B0' },
  { token: 'class.definition', foreground: '4EC9B0' },
  { token: 'type.declaration', foreground: '4EC9B0' },
  { token: 'type.definition', foreground: '4EC9B0' },
  { token: 'enum.declaration', foreground: '4EC9B0' },
  { token: 'interface.declaration', foreground: '4EC9B0' },
  { token: 'struct.declaration', foreground: '4EC9B0' },
  { token: 'namespace.declaration', foreground: '4EC9B0' },
  { token: 'function.declaration', foreground: 'DCDCAA' },
  { token: 'function.definition', foreground: 'DCDCAA' },
  { token: 'method.declaration', foreground: 'DCDCAA' },
  { token: 'method.definition', foreground: 'DCDCAA' },
  
  { token: 'class.defaultLibrary', foreground: '4EC9B0' },
  { token: 'type.defaultLibrary', foreground: '4EC9B0' },
  { token: 'function.defaultLibrary', foreground: 'DCDCAA' },
  { token: 'method.defaultLibrary', foreground: 'DCDCAA' },
  
  { token: 'selfParameter', foreground: '569CD6' },
  { token: 'clsParameter', foreground: '569CD6' }
]

/** Light-plus equivalents of the semantic token colors above. */
const VS_LIGHT_PLUS_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: 'namespace', foreground: '267F99' },
  { token: 'type', foreground: '267F99' },
  { token: 'class', foreground: '267F99' },
  { token: 'enum', foreground: '267F99' },
  { token: 'interface', foreground: '267F99' },
  { token: 'struct', foreground: '267F99' },
  { token: 'typeParameter', foreground: '267F99' },
  { token: 'parameter', foreground: '001080' },
  { token: 'variable', foreground: '001080' },
  { token: 'property', foreground: '001080' },
  { token: 'enumMember', foreground: '0070C1' },
  { token: 'function', foreground: '795E26' },
  { token: 'method', foreground: '795E26' },
  { token: 'macro', foreground: '795E26' },
  { token: 'decorator', foreground: '795E26' },
  { token: 'variable.readonly', foreground: '0070C1' },
  { token: 'property.readonly', foreground: '0070C1' },
  { token: 'class.declaration', foreground: '267F99' },
  { token: 'class.definition', foreground: '267F99' },
  { token: 'type.declaration', foreground: '267F99' },
  { token: 'type.definition', foreground: '267F99' },
  { token: 'enum.declaration', foreground: '267F99' },
  { token: 'interface.declaration', foreground: '267F99' },
  { token: 'struct.declaration', foreground: '267F99' },
  { token: 'namespace.declaration', foreground: '267F99' },
  { token: 'function.declaration', foreground: '795E26' },
  { token: 'function.definition', foreground: '795E26' },
  { token: 'method.declaration', foreground: '795E26' },
  { token: 'method.definition', foreground: '795E26' },
  { token: 'class.defaultLibrary', foreground: '267F99' },
  { token: 'type.defaultLibrary', foreground: '267F99' },
  { token: 'function.defaultLibrary', foreground: '795E26' },
  { token: 'method.defaultLibrary', foreground: '795E26' },
  { token: 'selfParameter', foreground: '0000FF' },
  { token: 'clsParameter', foreground: '0000FF' }
]

function activeSemanticRules(): monaco.editor.ITokenThemeRule[] {
  return isLightPreset() ? VS_LIGHT_PLUS_SEMANTIC_RULES : VS_DARK_PLUS_SEMANTIC_RULES
}

const CHAT_LANG_ALIASES: Record<string, string> = {
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  yml: 'yaml',
  md: 'markdown',
  dockerfile: 'docker'
}

export function resolveShikiLang(raw?: string): string | null {
  const key = raw?.trim().toLowerCase() ?? ''
  if (!key || key === 'text' || key === 'plain' || key === 'plaintext' || key === 'txt') {
    return null
  }
  return CHAT_LANG_ALIASES[key] ?? key
}

function registerCustomLanguages(): void {
  const existing = new Set(monaco.languages.getLanguages().map((l) => l.id))
  for (const id of CUSTOM_LANGS) {
    if (!existing.has(id)) monaco.languages.register({ id })
  }
  monaco.languages.setLanguageConfiguration('tsx', TS_LIKE_CONFIG)
  monaco.languages.setLanguageConfiguration('jsx', TS_LIKE_CONFIG)
}

function lockTokenizers(): void {
  const ns = monaco.languages as typeof monaco.languages & { __shikiLocked?: boolean }
  if (ns.__shikiLocked) return
  ns.__shikiLocked = true

  const noop: monaco.IDisposable = { dispose() {} }

  const origSetTokens = monaco.languages.setTokensProvider
  monaco.languages.setTokensProvider = ((languageId, provider) => {
    if (lockActive && ownedLanguages.has(languageId)) return noop
    return origSetTokens(languageId, provider)
  }) as typeof monaco.languages.setTokensProvider

  const origSetMonarch = monaco.languages.setMonarchTokensProvider
  monaco.languages.setMonarchTokensProvider = ((languageId, provider) => {
    if (lockActive && ownedLanguages.has(languageId)) return noop
    return origSetMonarch(languageId, provider)
  }) as typeof monaco.languages.setMonarchTokensProvider

  const origRegFactory = (monaco.languages as unknown as Record<string, unknown>)
    .registerTokensProviderFactory as
    | ((languageId: string, factory: unknown) => monaco.IDisposable)
    | undefined
  if (origRegFactory) {
    ;(monaco.languages as unknown as Record<string, unknown>).registerTokensProviderFactory = (
      languageId: string,
      factory: unknown
    ): monaco.IDisposable => {
      if (lockActive && ownedLanguages.has(languageId)) return noop
      return origRegFactory(languageId, factory)
    }
  }

  lockActive = true
}


function editorSurfaceColors(): Record<string, string> {
  const bg = cssVar('--bg', '#1e1e1e')
  const fg = cssVar('--text', '#d4d4d4')
  return {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorGutter.background': bg,
    'minimap.background': bg,
    'editorLineNumber.foreground': cssVar('--text-dim', '#858585'),
    'editorLineNumber.activeForeground': cssVar('--text-bright', '#c6c6c6'),
    'editorWidget.background': cssVar('--bg-overlay', '#252526'),
    'editor.lineHighlightBackground': cssVar('--bg-hover', '#2a2a2a')
  }
}

function applyShikiThemeAndTokenizers(): void {
  if (!highlighter) return
  lockActive = false
  shikiToMonaco(highlighter, monaco)
  const themeName = activeShikiTheme()
  const theme = textmateThemeToMonacoTheme(
    highlighter.getTheme(themeName)
  ) as unknown as monaco.editor.IStandaloneThemeData
  monaco.editor.defineTheme(themeName, {
    ...theme,
    colors: {
      ...theme.colors,
      ...editorSurfaceColors()
    },
    rules: [...theme.rules, ...activeSemanticRules()]
  })
  monaco.editor.setTheme(themeName)
  lockActive = true
}

function reinforceShikiTokenizers(): void {
  if (!highlighter) return
  const delays = [0, 50, 200, 800]
  for (const delay of delays) {
    setTimeout(applyShikiThemeAndTokenizers, delay)
  }
  monaco.editor.onDidCreateModel((model) => {
    if (ownedLanguages.has(model.getLanguageId())) setTimeout(applyShikiThemeAndTokenizers, 0)
    model.onDidChangeLanguage(() => {
      if (ownedLanguages.has(model.getLanguageId())) setTimeout(applyShikiThemeAndTokenizers, 0)
    })
  })
  for (const model of monaco.editor.getModels()) {
    if (ownedLanguages.has(model.getLanguageId())) setTimeout(applyShikiThemeAndTokenizers, 0)
  }
}

export function setupHighlighting(): Promise<void> {
  if (readyPromise) return readyPromise
  registerCustomLanguages()
  readyPromise = createHighlighter({
    themes: [SHIKI_DARK, SHIKI_LIGHT],
    langs: SHIKI_LANGS
  })
    .then((instance) => {
      highlighter = instance
      applyShikiThemeAndTokenizers()

      const monacoIds = new Set(monaco.languages.getLanguages().map((l) => l.id))
      for (const lang of instance.getLoadedLanguages()) {
        if (monacoIds.has(lang)) ownedLanguages.add(lang)
      }

      lockTokenizers()
      shikiOk = true
      reinforceShikiTokenizers()
    })
    .catch((err) => {
      console.error('[highlight] Shiki 初始化失败，回退到内置着色：', err)
    })
    .finally(() => {
      loaded = true
    })
  return readyPromise
}

export function whenHighlightingReady(): Promise<void> {
  return readyPromise ?? setupHighlighting()
}

export function isHighlightingReady(): boolean {
  return loaded
}

export function getEditorTheme(): string {
  if (shikiOk) return activeShikiTheme()
  return isLightPreset() ? 'vs' : 'vs-dark'
}

/** Re-applies editor surface colors from the current CSS theme vars. Safe to
 *  call before highlighting is ready (no-op until shiki initializes). */
export function refreshEditorTheme(): void {
  if (!highlighter) return
  applyShikiThemeAndTokenizers()
}


export async function highlightCodeHtml(code: string, rawLang?: string): Promise<string | null> {
  await whenHighlightingReady()
  if (!shikiOk || !highlighter) return null

  const lang = resolveShikiLang(rawLang)
  if (!lang) return null

  const loaded = new Set(highlighter.getLoadedLanguages())
  if (!loaded.has(lang)) return null

  try {
    return highlighter.codeToHtml(code, {
      lang,
      theme: activeShikiTheme(),
      defaultColor: false
    })
  } catch {
    return null
  }
}
