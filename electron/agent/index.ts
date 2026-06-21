
import { registerAiIpc } from '../ipc/ai'
import { registerEditorIpc } from '../ipc/editor'
import { registerSecretsIpc } from '../ipc/secrets'
import { registerMcpIpc } from '../ipc/mcp'
import { registerSkillsIpc } from '../ipc/skills'

export function registerAgentModule(): void {
  registerSecretsIpc()
  registerEditorIpc()
  registerAiIpc()
  registerMcpIpc()
  registerSkillsIpc()
}
