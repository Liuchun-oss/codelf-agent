import { MONACO_ZH_CN } from './lsp/monacoNlsZh'

/**
 * Must run BEFORE monaco-editor is imported/evaluated, because Monaco eagerly
 * calls nls.localize() at module load time when registering menus/actions.
 */
;(globalThis as unknown as { __MONACO_ZH__?: Record<string, string> }).__MONACO_ZH__ =
  MONACO_ZH_CN
