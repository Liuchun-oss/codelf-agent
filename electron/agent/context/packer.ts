import type { ContextAttachment, EditorContextSnapshot } from '@shared/agentTypes'
import type { ProviderKind } from '@shared/agentTypes'
import {
  countTokens,
  DEFAULT_ATTACHMENT_TOKEN_BUDGET,
  truncateToTokenBudget
} from './tokenCounter'



export { countTokens, DEFAULT_ATTACHMENT_TOKEN_BUDGET } from './tokenCounter'

export interface BuildUserMessageOptions {
  model?: string
  providerKind?: ProviderKind
  maxAttachmentTokens?: number
}

function fence(label: string, body: string, truncated: boolean): string {
  const note = truncated ? ' (truncated)' : ''
  return `<<< ${label}${note} >>>\n${body}\n<<< end ${label} >>>`
}

function truncateAttachment(
  text: string,
  maxTokens: number,
  model?: string,
  kind?: ProviderKind
): { text: string; truncated: boolean } {
  return truncateToTokenBudget(text, maxTokens, model, kind)
}


export function buildUserMessage(
  message: string,
  editorContext?: EditorContextSnapshot,
  attachments?: ContextAttachment[],
  options?: BuildUserMessageOptions
): string {
  const maxTok = options?.maxAttachmentTokens ?? DEFAULT_ATTACHMENT_TOKEN_BUDGET
  const model = options?.model
  const kind = options?.providerKind
  const blocks: string[] = []

  if (editorContext?.selection && editorContext.selection.trim().length > 0) {
    const { text, truncated } = truncateAttachment(
      editorContext.selection,
      maxTok,
      model,
      kind
    )
    const where = editorContext.activeFilePath
      ? `${editorContext.activeFilePath}:${editorContext.selectionStartLine ?? '?'}-${editorContext.selectionEndLine ?? '?'}`
      : 'active selection'
    blocks.push(fence(`selection ${where}`, text, truncated))
  }

  for (const att of attachments ?? []) {
    if (att.kind === 'file' && att.content) {
      const { text, truncated } = truncateAttachment(att.content, maxTok, model, kind)
      blocks.push(fence(`file ${att.path ?? ''}`, text, truncated))
    } else if (att.kind === 'selection' && att.content) {
      const { text, truncated } = truncateAttachment(att.content, maxTok, model, kind)
      blocks.push(fence(`selection ${att.path ?? ''}`, text, truncated))
    } else if (att.kind === 'folder' && att.content) {
      const { text, truncated } = truncateAttachment(att.content, maxTok, model, kind)
      blocks.push(fence(`folder ${att.path ?? ''}`, text, truncated))
    } else if (att.kind === 'rule' && att.content) {
      const { text, truncated } = truncateAttachment(att.content, maxTok, model, kind)
      blocks.push(fence(`rule ${att.path ?? ''}`, text, truncated))
    }
  }

  if (blocks.length === 0) return message
  return `${blocks.join('\n\n')}\n\n${message}`
}


export function estimateTokens(text: string, model?: string, kind?: ProviderKind): number {
  return countTokens(text, model, kind)
}
