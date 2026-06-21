import { killAllTerminals } from '../ipc/terminal'
import { killAllInlineRuns } from '../ipc/inlineRun'
import { stopAllLsp } from '../ipc/lsp'
import { stopWatcher } from '../ipc/watcher'
import { resetBrowserSessions } from './browserSession'
import { resetDesktopSessions } from './desktopSession'
import { resetBrowserPreviews } from './browserPreviewImage'
import { setActiveAgentWebContents } from './diagnosticsBridge'
import { clearAllSubagentEventSinks } from '../agent/orchestrator/subagent'
import { clearAllBackgroundToolEventSinks } from '../agent/orchestrator/backgroundToolExecution'

export async function cleanupRendererBoundResources(): Promise<void> {
  killAllTerminals()
  killAllInlineRuns()
  stopAllLsp()
  stopWatcher()
  setActiveAgentWebContents(null)
  clearAllSubagentEventSinks()
  clearAllBackgroundToolEventSinks()
  resetDesktopSessions()
  await Promise.all([resetBrowserSessions(), resetBrowserPreviews()])
}
