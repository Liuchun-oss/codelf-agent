import { DATA_DIR_NAME } from '@shared/appConfig'
import type { PromptContext } from '../types'

// 把 .codelf/ 项目目录的约定告诉主 Agent，避免它在"写 skill / 配 MCP / 加规则"时
// 不知道文件该放哪。内容固定不变，放入静态核心以进入提示词缓存。
export function getProjectLayoutSection(_ctx: PromptContext): string {
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
