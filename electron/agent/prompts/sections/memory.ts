import type { PromptContext } from '../types'

/**
 * 记忆系统使用指南。放在静态段，长期引导 Agent 主动记笔记。
 */
export function getMemorySection(_ctx: PromptContext): string {
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
