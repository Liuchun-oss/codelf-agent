import type { PromptContext } from '../types'
import { prependBullets } from '../types'
import { DATA_DIR_NAME } from '@shared/appConfig'
import { READ_FILE_NAME } from '../tools/readFile'
import { LIST_DIR_NAME } from '../tools/listDir'
import { GREP_NAME } from '../tools/grep'
import { CODEBASE_SEARCH_NAME } from '../tools/codebaseSearch'
import { TERMINAL_NAME } from '../tools/terminal'
import { WRITE_FILE_NAME, EDIT_FILE_NAME, DELETE_FILE_NAME } from '../tools/writeFile'
import { GET_DIAGNOSTICS_NAME } from '../tools/diagnostics'
import { ASK_USER_NAME } from '../../tools/userTools'
import { SEARCH_EXTRA_TOOLS_NAME, EXECUTE_EXTRA_TOOL_NAME } from '../../tools/deferredTools'
import { TASK_CREATE_NAME, TASK_UPDATE_NAME, TASK_LIST_NAME, TASK_GET_NAME } from '../../tools/taskTools'
import { SKILL_TOOL_NAME } from '../../tools/skillTool'
import { INSTALL_SKILL_TOOL_NAME } from '../../tools/installSkillTool'


export function getUsingToolsSection(ctx: PromptContext): string {
  const enabled = new Set(ctx.enabledTools)
  if (enabled.size === 0) return ''

  const has = (name: string): boolean => enabled.has(name)

  
  const preferences: string[] = []
  if (has(READ_FILE_NAME)) preferences.push(`To read a file use ${READ_FILE_NAME} instead of \`cat\`, \`head\`, \`tail\`, or \`sed\`.`)
  if (has(EDIT_FILE_NAME)) preferences.push(`To edit a file use ${EDIT_FILE_NAME} instead of \`sed\` or \`awk\`.`)
  if (has(WRITE_FILE_NAME)) preferences.push(`To create or overwrite a file use ${WRITE_FILE_NAME} instead of \`cat\` heredocs or \`echo >\` redirection.`)
  if (has(GREP_NAME)) preferences.push(`To search file contents use ${GREP_NAME} instead of \`grep\` or \`rg\`.`)
  if (has(LIST_DIR_NAME)) preferences.push(`To list a directory use ${LIST_DIR_NAME} instead of \`ls\` or \`find\`.`)
  if (has(DELETE_FILE_NAME)) preferences.push(`To delete a file use ${DELETE_FILE_NAME} instead of \`rm\`; the user will always be asked to confirm.`)
  if (has(TERMINAL_NAME)) {
    preferences.push(`Reserve ${TERMINAL_NAME} for shell-only operations (running tests, build commands, package managers, git). When in doubt and a dedicated tool exists, default to the dedicated tool.`)
    preferences.push(`When using ${TERMINAL_NAME}, write commands for the current Shell exactly as shown in the Environment section. If Shell is Windows PowerShell, avoid bash-only syntax such as \`&&\`, \`||\`, heredocs, \`export\`, \`rm -rf\`, and inline environment assignments; use PowerShell syntax instead.`)
  }
  if (has(GET_DIAGNOSTICS_NAME)) {
    preferences.push(`To see TypeScript/LSP errors on open files use ${GET_DIAGNOSTICS_NAME} instead of guessing from partial reads.`)
  }
  if (has(SEARCH_EXTRA_TOOLS_NAME) && has(EXECUTE_EXTRA_TOOL_NAME)) {
    preferences.push(`Some lower-frequency or large-description tools are deferred to protect context budget. If the task needs a specialized tool that is not directly available, use ${SEARCH_EXTRA_TOOLS_NAME} first, then ${EXECUTE_EXTRA_TOOL_NAME}. Do not use deferred discovery for work a core tool can do.`)
  }
  if (has(ASK_USER_NAME)) {
    preferences.push(`When you are blocked by missing requirements or need the user to choose between concrete options, use ${ASK_USER_NAME}; it will show a prompt to the user and wait for their answer.`)
  }
  if (has(SKILL_TOOL_NAME)) {
    preferences.push(`If the system prompt lists an Available skill that matches the user's task, call ${SKILL_TOOL_NAME} with the exact skill name before executing that workflow. The tool loads the full SKILL.md instructions on demand; do not guess the full workflow from the summary alone.`)
  }
  if (has(INSTALL_SKILL_TOOL_NAME)) {
    preferences.push(`If the user needs a capability that no Available skill covers, and they point you to a skill source (a GitHub repo/URL, owner/repo shorthand, or git URL), use ${INSTALL_SKILL_TOOL_NAME} to download, adapt (tool-name remapping + frontmatter normalization), and install it into ~/${DATA_DIR_NAME}/skills. Use listOnly first to confirm what a source contains. After install, the skill appears in Available skills on the next turn and can be invoked with ${SKILL_TOOL_NAME}.`)
  }

  const mcpServers = new Set<string>()
  for (const name of enabled) {
    if (name.startsWith('mcp__')) {
      const seg = name.slice('mcp__'.length).split('__')[0]
      if (seg) mcpServers.add(seg)
    }
  }
  if (mcpServers.size > 0) {
    preferences.push(
      `Tools named \`mcp__<server>__<tool>\` come from connected MCP (Model Context Protocol) servers (${[...mcpServers].join(', ')}). They are deferred: discover them with ${SEARCH_EXTRA_TOOLS_NAME} and run them with ${EXECUTE_EXTRA_TOOL_NAME}. Prefer a built-in core tool when it can do the same job; reach for an MCP tool when the task needs that server's specific capability.`
    )
  }

  const hasTaskTools = has(TASK_CREATE_NAME) && has(TASK_UPDATE_NAME) && has(TASK_LIST_NAME) && has(TASK_GET_NAME)

  
  const hasSearchStrategy = has(CODEBASE_SEARCH_NAME) && has(GREP_NAME)
  const searchStrategy: string[] = []
  if (hasSearchStrategy) {
    searchStrategy.push(
      `${CODEBASE_SEARCH_NAME} ranks the workspace by relevance to your query. When a semantic index has been built it matches by meaning (so conceptual queries like "how does login work" can surface code that says "verifyToken"/"session"); otherwise it falls back to lexical keyword matching. Use it when you do NOT yet know the exact symbol — searching by concept, behavior, or feature.`
    )
    searchStrategy.push(
      `${GREP_NAME} is for exact, known text: once you have a concrete symbol name (a function, class, constant, or error string), use ${GREP_NAME} to jump to its definition and map every usage. For "find the definition of X" where X is a known name, prefer ${GREP_NAME} directly.`
    )
    searchStrategy.push(
      `If a query returns weak or no hits, reformulate with synonyms and concrete vocabulary (e.g. "auth", "login", "session", "credential", "verifyToken") and try several variations in parallel before concluding the concept is absent.`
    )
    searchStrategy.push(
      `Treat search as an iterative loop: ${CODEBASE_SEARCH_NAME} to discover candidate code → read_file the most promising hits to learn the real symbol names → ${GREP_NAME} those exact symbols to find all definitions and usages → read_file to confirm before editing. Do not act on a single ranked hit without confirming.`
    )
  }

  const items: Array<string | string[]> = []
  if (has(TERMINAL_NAME) && preferences.length > 1) {
    items.push(
      `Do NOT use ${TERMINAL_NAME} when a dedicated tool is provided. Dedicated tools let the user see and review your work clearly. This is CRITICAL:`,
      preferences
    )
  } else if (preferences.length > 0) {
    for (const p of preferences) items.push(p)
  }

  if (hasTaskTools) {
    items.push(
      `Use ${TASK_CREATE_NAME}/${TASK_UPDATE_NAME}/${TASK_LIST_NAME}/${TASK_GET_NAME} to manage complex work. For tasks with 3+ meaningful steps, or when the user asks for a task list, create tasks before implementation. Mark exactly one active task as in_progress before starting it, mark it completed immediately after it is fully done, and do not batch multiple completions at the end. After completing a task, use ${TASK_LIST_NAME} to check remaining work and continue in ID order unless dependencies or user instructions require otherwise.`
    )
  }

  if (hasSearchStrategy) {
    items.push(`Searching the codebase effectively:`, searchStrategy)
  }

  items.push(
    `You can call multiple tools in a single response. When tool calls are independent, issue them in parallel to maximize throughput. When one call depends on the result of another, sequence them — do not batch dependent calls in parallel.`
  )

  if (ctx.workspacePath) {
    items.push(`All tool \`path\` arguments are relative to the workspace root, unless absolute paths are clearly required. Always quote paths that contain spaces.`)
  } else {
    items.push(`No workspace is open. Tools that require a workspace path will fail; prefer plain explanations until the user opens a folder.`)
  }

  return [`# Using your tools`, ...prependBullets(items)].join('\n')
}
