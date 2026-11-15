import type { PromptContext } from '../types'
import { REDTEAM_ROLE_PROMPTS } from '../../redteam/prompts.data'

/**
 * 红队指挥官段。
 *
 * 开启「红队演练工具箱」时追加到主 Agent 的系统提示词动态段（在
 * PROMPT_DYNAMIC_BOUNDARY 之后，不影响 prompt 缓存的静态前缀）。
 *
 * 正文取自 redteam/prompts.data.ts 的 plan，末尾再补一节「本地工具对照」，
 * 把角色正文里提到的工具与 codelf 实际提供的工具对齐，避免模型去调不存在的工具。
 */
export function getRedteamCommanderSection(ctx: PromptContext): string | null {
  if (!ctx.redteamCommander) return null
  const plan = REDTEAM_ROLE_PROMPTS.plan
  const adaptation = [
    '## 本地工具对照（codelf，必读）',
    '',
    '- **派活**：用 `run_subagent`，`subagentType` 传 `redteam-recon` / `redteam-assess` /',
    '  `redteam-vuln-scan` / `redteam-exploit` / `redteam-internal`。',
    '  子任务 `task` 第一行写 `redteamRole: <code>` 作标记；角色提示词由 `subagentType` 自动装载，',
    '  不要把 `redteam_role_prompt` 的全文抄进任务。',
    '- **开工体检**：`redteam_preflight` 返回 `missing`（缺什么）、',
    '  `toolkit.found` / `toolkit.missing`（本机工具链）、`roles` 与 `permissions`（写入类工具的权限要求）。',
    '  把 `missing` 与 `toolkit.missing` 一次性列给用户补齐。',
    '- **并发闸**：`redteam_agent_slot`，action 取 status / acquire / release，上限 3。',
    '- **总览**：`redteam_sessions` 一屏看 WebShell、隧道（含 entry_kind 判定）、凭据、访问会话与得分。',
    '- **报告**：`redteam_score_report` 出得分复现报告（Markdown），`redteam_report_targets` 按目标汇总。',
    '- **POC 知识库**：`redteam_poc_search` / `poc_get` / `poc_add` / `poc_list` / `poc_update` / `poc_use`，',
    '  跨靶标共享。',
    '- **角色提示词**：`redteam_roles` 列角色，`redteam_role_prompt` 查看当前生效版本，',
    '  `redteam_role_prompt_reset` 恢复内置默认。',
    '',
    '其余 `redteam_*` 工具按名字直接调用即可。'
  ].join('\n')
  return [plan, adaptation].join('\n\n')
}
