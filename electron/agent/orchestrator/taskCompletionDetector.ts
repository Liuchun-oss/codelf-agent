import type { ChatMessage } from '../providers'
import type { ToolCallRequest } from '../providers'

/**
 * 任务完成检测器。用于判断当前 turn 是否完成了值得记笔记的复杂任务。
 *
 * 触发条件（满足任一即可）：
 * 1. 本轮调用了 3+ 个工具（复杂任务信号）
 * 2. 本轮调用了写文件工具（edit_file / write_file）且有 tool_call_result（说明完成了代码修改）
 * 3. 本轮调用了 run_terminal_cmd 且后续还有其他工具（说明有验证/调试流程）
 * 4. 本轮 Assistant 输出超过 800 字符（长篇回复通常伴随复杂任务）
 */

const COMPLEX_TASK_TOOL_COUNT_THRESHOLD = 3
const COMPLEX_TASK_TEXT_LENGTH_THRESHOLD = 800

const WRITE_FILE_TOOLS = new Set(['edit_file', 'write_file'])
const VERIFICATION_TOOLS = new Set(['run_terminal_cmd', 'run_command'])

export interface TaskCompletionSignal {
  shouldRemind: boolean
  reason?: string
}

export function detectTaskCompletion(params: {
  turnMessages: ChatMessage[]
  toolCalls: ToolCallRequest[]
  finalText: string
}): TaskCompletionSignal {
  const { turnMessages, toolCalls, finalText } = params

  // 条件 1: 工具调用数量
  if (toolCalls.length >= COMPLEX_TASK_TOOL_COUNT_THRESHOLD) {
    return { shouldRemind: true, reason: `called ${toolCalls.length} tools` }
  }

  // 条件 2: 写文件 + 有结果（说明完成了修改）
  const hasWriteFile = toolCalls.some((c) => WRITE_FILE_TOOLS.has(c.name))
  const hasToolResults = turnMessages.some((m) => m.role === 'tool')
  if (hasWriteFile && hasToolResults) {
    return { shouldRemind: true, reason: 'completed file edits' }
  }

  // 条件 3: 运行命令 + 后续有其他工具（说明有验证流程）
  const verificationCallIndex = toolCalls.findIndex((c) => VERIFICATION_TOOLS.has(c.name))
  if (verificationCallIndex >= 0 && toolCalls.length > verificationCallIndex + 1) {
    return { shouldRemind: true, reason: 'ran verification commands' }
  }

  // 条件 4: 长篇回复
  if (finalText.length >= COMPLEX_TASK_TEXT_LENGTH_THRESHOLD) {
    return { shouldRemind: true, reason: `long response (${finalText.length} chars)` }
  }

  return { shouldRemind: false }
}

/**
 * 生成记笔记提醒文本（中文）。
 */
export function buildNoteReminder(turnId: string): string {
  return `[任务完成提示 · turn ${turnId}]

你刚完成了一个非平凡的任务。建议主动调用 \`append_note\` 工具记录：

- **关键步骤**：做了什么、为什么这样做
- **踩过的坑**：遇到的错误及解法（错误原因 + 解决方案）
- **验证结果**：测试/运行输出，是否符合预期
- **项目发现**：代码约定、架构模式、特殊配置等非显而易见的知识
- **设计决策**：技术选型理由、权衡因素

格式示例：
\`\`\`markdown
## [turn ${turnId}] 任务简要标题

**问题**：简述原始需求或问题
**解法**：关键步骤（2-3 点）
**踩坑**：遇到的具体错误及解决方式
**验证**：测试结果或运行截图
**发现**：项目约定或架构洞察（如有）
\`\`\`

这是你写入长期记忆的唯一途径。无需等用户指示，现在就记。`
}
