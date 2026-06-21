import type { WebContents } from 'electron'
import type { DiagnosticEntry } from '@shared/diagnostics'
import { DIAGNOSTICS_GLOBAL } from '@shared/appConfig'

export type { DiagnosticEntry }

let activeWebContents: WebContents | null = null


export function setActiveAgentWebContents(wc: WebContents | null): void {
  activeWebContents = wc
}


export async function fetchDiagnosticsFromRenderer(): Promise<DiagnosticEntry[]> {
  if (!activeWebContents || activeWebContents.isDestroyed()) return []
  try {
    const rows = await activeWebContents.executeJavaScript(
      `typeof window[${JSON.stringify(DIAGNOSTICS_GLOBAL)}]==="function"?window[${JSON.stringify(DIAGNOSTICS_GLOBAL)}]():[]`,
      true
    )
    return Array.isArray(rows) ? (rows as DiagnosticEntry[]) : []
  } catch {
    return []
  }
}
