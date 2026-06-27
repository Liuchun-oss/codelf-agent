import { DATA_DIR_NAME } from '@shared/appConfig'
import type { PromptContext } from '../types'

// 把 .codelf/ 项目目录的约定告诉主 Agent，避免它在"写 skill / 配 MCP / 加规则"时
// 不知道文件该放哪。内容固定不变，放入静态核心以进入提示词缓存。
//
// 群聊岗位例外：工人岗位被路径围栏锁在自己的 seats/<id>/ 工作区内，且禁用 run_subagent，
// 通用的 .codelf/ + app data 指引对它无用且会误导（让它以为能写 .codelf/agents/、读 app data）。
// 因此群聊回合改输出「岗位工作区约定」精简版（host 也走精简版，避免它替全群乱铺 .codelf/）。
export function getProjectLayoutSection(ctx: PromptContext): string {
  if (ctx.roomContext) return roomSeatLayout(ctx)
  const d = DATA_DIR_NAME
  return `# Project config layout (${d}/)

Project-level configuration lives under the \`${d}/\` directory at the workspace root (committable, shared via git). When the user asks you to add or edit any of these, create the file at the path below; create parent directories as needed.

- \`${d}/AGENTS.md\` — Project instructions injected into every turn. Plain Markdown describing stack, conventions, structure, and preferences.
- \`${d}/agents/<id>.md\` — A project sub-agent definition. YAML frontmatter (\`title\`, \`description\`, \`readOnly\`, optional \`model\`, optional \`deniedTools\`) followed by the agent prompt body. Invoke via run_subagent with subagentType set to the file's \`<id>\`.
- \`${d}/skills/<name>/SKILL.md\` — A project skill. Frontmatter (\`name\`, \`description\`, optional \`context\`, \`allowed-tools\`) plus instructions; appears under Available skills next turn and runs via the Skill tool.
- \`${d}/mcp.json\` — Project MCP servers. JSON of the form \`{ "mcpServers": { "<server>": { "command": "...", "args": [...], "env": {...} } } }\`. Project servers require user approval before connecting.
- \`${d}/rules/<name>.md\` — A project rule (coding standard / convention) the agent should follow when relevant.
- \`${d}/settings.json\` — Project permission rules and hooks.
- \`${d}/plan/<slug>.md\` — Plan documents (策划书) for complex tasks.

User-global (cross-project, in the home directory): \`~/${d}/skills\` and \`~/${d}/plugins\`.

# App data directory (private, machine-local)

Private, machine-local runtime data lives in the Electron app data directory (\`app.getPath('userData')\`, e.g. \`%APPDATA%/${d}\` on Windows), NOT under the project \`${d}/\`. It is not committed to git. You CAN read, write, and edit these files when the user asks you to (e.g. fix a corrupted config, bulk-edit memory, prune sessions) — resolve the directory via the OS path and use read_file / write_file / edit_file like any other file. Prefer the dedicated tools or settings UI when one exists (e.g. ModelConfig for providers), since these files are mostly strict JSON and easy to corrupt by hand; fall back to direct editing when no tool fits. Two cautions: \`secrets.json\` holds API keys — you may rewrite it if asked, but never read back or echo key values into the chat; and keep JSON valid. It contains:
- \`profiles.json\` — model provider configs; \`secrets.json\` — API keys (never read or echo these); \`settings.json\` — app settings; \`pythonEnv.json\`, \`window-state.json\`.
- \`sessions/\` — chat sessions; \`subagents/\` — background sub-agent records.
- \`memory/\` — long-term memory: \`global/MEMORY.md\`, \`projects/<pid>/MEMORY.md\`, \`sessions/<sid>/notes.md\` and \`checkpoint.md\`.
- \`knowledge/\`, \`semantic-index/\`, \`models/\` — knowledge base, semantic index, local embedding models.
- \`generated-images/\`, \`generated-audio/\`, \`generated-videos/\`, \`video-tasks.json\` — fallback location for generated media when no output path is given (media tools save into the workspace when you pass an explicit output path).
- \`logs/\`, \`audit.log\` — app logs and tool/permission audit trail.

When the user wants to inspect or change provider/model settings, memory, or other private data, you may use the dedicated tools (e.g. ModelConfig), point them at the settings UI, or edit the underlying file directly — whichever best fits the request.`
}

// 群聊岗位专用的「目录约定」精简版。只讲与岗位真实环境相符的事：
// 工作区在哪、围栏边界、产物归置。不提 .codelf/ 全套与 app data（岗位无权也无需碰）。
function roomSeatLayout(ctx: PromptContext): string {
  const room = ctx.roomContext!
  const ws = room.seat.workspaceRoot
  const lines: string[] = ['# 你的文件工作区']
  lines.push('')
  if (ws) {
    lines.push(`你的默认工作目录是 \`${ws}\`，相对路径都从这里算起，也是你存放自己产物的私有空间。`)
    lines.push('你有权读写这台机器上的其它目录（含用户现有项目）。操作某个项目时请用它的绝对路径，否则相对路径会落进你的默认目录、改错地方。')
    lines.push('红线：密钥/敏感文件（.env、.pem、.key、凭据等）与系统目录禁止写入，会被拦截。')
    lines.push('产物按「一项目一子文件夹」归置，分门别类，不要散落或互相覆盖。')
  } else {
    lines.push('你是纯对话岗位，不直接读写文件。需要落地产物时，把内容讲清楚交给有写权限的岗位或 @主管 协调。')
  }
  return lines.join('\n')
}
