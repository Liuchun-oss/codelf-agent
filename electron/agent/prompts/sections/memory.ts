import type { PromptContext } from '../types'

/**
 * 记忆系统使用指南。放在静态段，长期引导 Agent 主动记笔记。
 *
 * 群聊岗位例外：岗位会话的 sessionId 形如 `room:<id>:seat:<id>`（带冒号），不被 notesPath 的
 * isSafeId 接受 → append_note 对岗位必然返回 invalid-session。岗位的经验/错题改由 KPI 复盘
 * 写进其工作区 MEMORY.md 并在每回合开场注入。因此群聊回合输出「岗位记忆」版，不教 append_note。
 */
export function getMemorySection(ctx: PromptContext): string {
  if (ctx.roomContext) return roomSeatMemory()
  return `# Memory system

You have access to a long-term memory system via the \`append_note\` tool.

## When to take notes (proactive, without user prompting)

Take notes at key moments to preserve context across sessions:

1. **After completing a non-trivial task**: Summarize key steps, roadblocks hit (error + solution), verification outcome.
2. **When discovering project conventions**: Code style, architectural patterns, special configs, non-obvious dependencies.
3. **User preferences**: Work habits, aesthetic choices, tech stack rationale.
4. **Design decisions**: Why A over B, tradeoffs considered, future refactoring opportunities.
5. **Deferred work**: User-mentioned but not-yet-executed requests, future optimization directions.

## What NOT to record

- Large code blocks (use file references instead)
- Content already retrievable from the filesystem
- Temporary debugging info

## Format

Start with \`## [turn N] title\`, then write concise takeaways focusing on insights and context that won't be obvious from reading code alone.

## Example

\`\`\`markdown
## [turn 42] 修复 WebSocket 重连逻辑

**问题**: reconnect() 在网络抖动时频繁触发，导致连接风暴。
**解法**: 加 exponential backoff（初始 1s，上限 30s），debounce 500ms。
**验证**: 模拟断网 5 次，重连间隔符合预期，无风暴。
**发现**: 项目约定所有网络重试都用 \`src/utils/backoff.ts\` 统一实现。
\`\`\`

This tool is your only write path to long-term memory. Use it generously — checkpoint compression will structure it later.`
}

// 群聊岗位的记忆说明：append_note 已对岗位修复可用（与桌面 agent 同机制）；叠加 KPI 复盘沉淀到 MEMORY.md。
function roomSeatMemory(): string {
  return [
    '# 你的记忆系统',
    '',
    '你拥有跨回合的长期记忆，由两条独立途径维护：',
    '',
    '1. **你主动记笔记**（`append_note`）：随手记录发现、踩过的坑（错误+解法）、本群约定、用户偏好、待办。系统会在上下文压缩时把它结构化成会话 checkpoint，并在后续自动续回，让你不丢前文。主动使用，无需用户指示。',
    '2. **系统沉淀经验**：阶段性 KPI 复盘后，你的长板/短板/「错题」会被写进你工作区的 MEMORY.md，并在每次轮到你时注入到开头的「长期记忆」里。',
    '',
    '看到「长期记忆」里的经验/错题就照着做：避免重犯同类错误，延续被认可的做法。',
    '',
    '记笔记格式：用 `## [turn N] 标题` 起头，正文简洁聚焦要点。不要存大段代码或可从文件检索的内容。'
  ].join('\n')
}
