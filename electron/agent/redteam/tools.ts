import { z } from 'zod'
import type { Tool, ToolResult } from '../tools/types'
import { TUNNEL_ENTRY_KINDS } from './scoreRules'
import { BUILTIN_SCORE_POINTS } from './scorePoints.data'
import { REDTEAM_ROLE_LABELS } from './prompts.data'
import {
  activeEngagementId,
  addAccess,
  addAttackFile,
  addCredential,
  addHttpEvidence,
  addPoc,
  addScoreHit,
  addShot,
  addStep,
  addTunnel,
  addVuln,
  addWebshell,
  agentSlot,
  assetGraph,
  assetStats,
  assetTimeline,
  assessAsset,
  attackChainView,
  attackPath,
  currentEngagement,
  deleteShot,
  domainIndex,
  getAssetDetail,
  getPoc,
  linkAssets,
  listAccess,
  listAttackFiles,
  listCredentials,
  listEngagements,
  listShots,
  listSteps,
  listTunnels,
  listWebshells,
  markAssetTest,
  markPocUsed,
  openEngagement,
  pocStats,
  queryAssets,
  queryVulns,
  readRolePrompt,
  reportTargets,
  resetRolePrompt,
  saveScorePoint,
  scoreBoard,
  scorePointsMap,
  scoreReport,
  searchPocs,
  sessionCheck,
  sessionsOverview,
  setActiveEngagement,
  updatePoc,
  updateTunnel,
  updateVuln,
  updateWebshell,
  upsertAsset,
  webList
} from './store'

/**
 * 红队演练工具（核心集）。
 *
 * 这些工具只读写 userData/redteam/redteam.db，不碰用户文件、不执行命令 —— 真正动手
 * 的扫描/利用由 Agent 用终端工具做，做完把结果落进这个库。
 *
 * 写入类工具 readOnly=false：默认模式下需要用户确认（或开 acceptEdits / 越狱模式），
 * 子 Agent 里尤其如此（见 subagent.ts 的 permissionEngine 分支）。
 */

function ok(data: unknown): ToolResult {
  return { content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }
}

function fail(message: string): ToolResult {
  return { content: message, isError: true }
}

// ---------------------------------------------------------------- 靶标 / 会话

export const engagementOpenTool: Tool<{
  name: string
  scope?: string
  activateOnly?: boolean
}> = {
  name: 'redteam_engagement_open',
  description:
    '绑定本次演练的靶标（目标单位）与授权范围，后续所有落库都归属该靶标。' +
    '首次使用必须先调用它。传入已存在的靶标名会复用并切换过去；activateOnly=true 时只切换不新建。',
  schema: z.object({
    name: z.string().min(1).describe('靶标/目标单位名称，作为唯一标识'),
    scope: z.string().optional().describe('授权范围（域名、C 段、排除项等）。写清楚，后续判断越界靠它'),
    activateOnly: z.boolean().optional().describe('只切换到已存在的靶标，不新建')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    if (input.activateOnly) {
      const target = listEngagements().find((e) => e.id === input.name || e.name === input.name)
      if (!target) return fail(`靶标不存在：${input.name}。可先不带 activateOnly 调用以新建。`)
      return setActiveEngagement(target.id) ? ok({ ok: true, engagement: target }) : fail('切换靶标失败')
    }
    const e = openEngagement(input.name, input.scope)
    return ok({ ok: true, engagement: e, active: activeEngagementId() })
  }
}

export const sessionInfoTool: Tool<Record<string, never>> = {
  name: 'redteam_session_info',
  description:
    '查看当前会话绑定的靶标、已绑定的全部靶标、以及本靶标下的战果汇总（资产/漏洞/凭据/WebShell/隧道/得分）。' +
    '派活前后用它确认没有串到别的靶标上。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    const current = currentEngagement()
    const board = scoreBoard()
    return ok({
      active: current,
      engagements: listEngagements(),
      assets: assetStats(),
      credible: {
        webshells: listWebshells(undefined, 20).length,
        tunnels: listTunnels(undefined, 20).length,
        credentials: listCredentials(undefined, undefined, 20).length,
        steps: listSteps(undefined, 20).length
      },
      score: { total: board.total, max: board.maxTotal, counted: board.counted }
    })
  }
}

export const preflightTool: Tool<{ autoCreate?: boolean }> = {
  name: 'redteam_preflight',
  description:
    '开工前体检：确认是否已绑定靶标、本机红队工具链与关键环境变量是否齐备、以及写入类工具需要什么权限。' +
    '返回的 missing 就是缺的东西，一次性列给用户补齐再开工，不要在缺资源时硬干。',
  schema: z.object({
    autoCreate: z.boolean().optional().describe('未绑定靶标时是否自动创建一个占位靶标（默认 false，交给用户命名）')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const e = currentEngagement()
    if (!e && input.autoCreate) openEngagement('未命名靶标')
    const missing: string[] = []
    if (!currentEngagement()) missing.push('靶标未绑定（调用 redteam_engagement_open）')
    if (!process.env.FOFA_KEY) missing.push('FOFA_KEY（被动资产收集用，可选）')
    const tools = ['nmap', 'nuclei', 'fscan', 'gogo', 'suo5', 'frpc']
    const found: Record<string, boolean> = {}
    for (const t of tools) {
      const probe = process.platform === 'win32' ? `where ${t}` : `which ${t}`
      try {
        const { execFileSync } = await import('node:child_process')
        if (process.platform === 'win32') execFileSync('where', [t], { stdio: 'ignore' })
        else execFileSync('which', [t], { stdio: 'ignore' })
        found[t] = true
      } catch {
        found[t] = false
        void probe
      }
    }
    const missingTools = Object.entries(found)
      .filter(([, v]) => !v)
      .map(([k]) => k)
    return ok({
      ok: missing.length === 0,
      engagement: currentEngagement(),
      missing,
      toolkit: { found, missing: missingTools },
      roles: Object.entries(REDTEAM_ROLE_LABELS).map(([code, label]) => ({ code, label })),
      permissions:
        '写入类红队工具（asset_upsert / vuln_add / score_hit 等）在默认模式下需要逐条确认；' +
        '在子 Agent 里必须开启 acceptEdits 或越狱模式才能执行。查库类工具不受影响。',
      note: '工具链缺失不阻塞落库，但会让 recon / vuln-scan 拿不到真实数据。缺 key / 缺工具要一次性告诉用户。'
    })
  }
}

// ---------------------------------------------------------------- 资产

const portSchema = z.object({
  port: z.number().int().min(1).max(65535),
  proto: z.string().optional(),
  state: z.string().optional(),
  banner: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  service: z.string().optional(),
  product: z.string().optional(),
  version: z.string().optional()
})

export const assetUpsertTool: Tool<{
  ip: string
  segment?: string
  state?: string
  primaryName?: string
  confidence?: number
  provenance?: string
  tool?: string
  names?: string[]
  ports?: Array<z.infer<typeof portSchema>>
}> = {
  name: 'redteam_asset_upsert',
  description:
    '资产落库（幂等）。同一 (网段, IP) 重复写只更新字段，不会重复建。' +
    'provenance 必须写清这条资产怎么来的：passive（被动/公开数据源）或 active（主动探测）。' +
    '收完资产一定要落库——没落库的发现等于没发生，下游角色查不到就会重复劳动。',
  schema: z.object({
    ip: z.string().min(1).describe('资产 IP'),
    segment: z.string().optional().describe('所属网段（CIDR）。不填按 IPv4 /24 自动推导'),
    state: z.string().optional().describe('状态，如 alive / open / filtered'),
    primaryName: z.string().optional().describe('首要域名/主机名'),
    confidence: z.number().optional(),
    provenance: z.enum(['passive', 'active']).optional().describe('被动还是主动发现'),
    tool: z.string().optional().describe('来源工具，如 fofa / nmap / fscan'),
    names: z.array(z.string()).optional().describe('同时发现的域名，写 asset_name 表'),
    ports: z.array(portSchema).optional().describe('开放端口与服务')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const { asset, created } = upsertAsset(input)
      return ok({ ok: true, created, asset })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '资产落库失败')
    }
  }
}

export const assetQueryTool: Tool<{
  ip?: string
  segment?: string
  state?: string
  primaryName?: string
  testStatus?: string
  priority?: string
  limit?: number
}> = {
  name: 'redteam_asset_query',
  description:
    '查资产库。指挥核对子 Agent 是否真的把资产落了库、以及避免重复收集时用它。' +
    '支持按 IP / 网段 / 状态 / 域名 / 测试状态 / 易打性优先级筛选。',
  schema: z.object({
    ip: z.string().optional().describe('IP 模糊匹配'),
    segment: z.string().optional().describe('网段精确匹配（CIDR）'),
    state: z.string().optional(),
    primaryName: z.string().optional().describe('域名模糊匹配'),
    testStatus: z.string().optional().describe('untested / testing / tested / blocked'),
    priority: z.string().optional().describe('易打性优先级，如 high / medium / low'),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = queryAssets(input)
    return ok({ count: rows.length, assets: rows })
  }
}

export const assetStatsTool: Tool<Record<string, never>> = {
  name: 'redteam_asset_stats',
  description: '资产测绘统计：总数、按状态/测试状态/网段分布、开放端口数。用来判断「收全了没有」。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    return ok(assetStats())
  }
}

export const assetAssessTool: Tool<{
  assetId: number
  priority: string
  potential: string
  reason: string
  by?: string
}> = {
  name: 'redteam_asset_assess',
  description:
    '给单个资产打易打性评估（priority 先打谁 / potential 有多大把握 / reason 依据），' +
    '由 assess（资产梳理）角色逐条过完后写。产出「先打谁」的排序。',
  schema: z.object({
    assetId: z.number().int().describe('asset.id，从 redteam_asset_query 拿'),
    priority: z.string().min(1).describe('优先级，如 high / medium / low'),
    potential: z.string().min(1).describe('潜在价值/易打程度'),
    reason: z.string().min(1).describe('判断依据（看到了什么特征）'),
    by: z.string().optional().describe('评估者角色，如 assess')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    return assessAsset(input.assetId, input.priority, input.potential, input.reason, input.by)
      ? ok({ ok: true, assetId: input.assetId })
      : fail(`资产不存在：${input.assetId}`)
  }
}

export const assetTestTool: Tool<{
  assetId: number
  status: string
  notes?: string
  surface?: string
  by?: string
}> = {
  name: 'redteam_asset_test',
  description:
    '标记资产的测试状态（untested / testing / tested / blocked）与已知面（surface）。' +
    '打了但没打进去也要记 blocked，否则下游会重复劳动。',
  schema: z.object({
    assetId: z.number().int(),
    status: z.string().min(1),
    notes: z.string().optional().describe('测过什么、结论如何'),
    surface: z.string().optional().describe('已探明的入口/攻击面'),
    by: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    return markAssetTest(input.assetId, input.status, input.notes, input.surface, input.by)
      ? ok({ ok: true, assetId: input.assetId, status: input.status })
      : fail(`资产不存在：${input.assetId}`)
  }
}

// ---------------------------------------------------------------- 漏洞

export const vulnAddTool: Tool<{
  assetId?: number
  title: string
  cve?: string
  severity?: string
  source?: string
  confidence?: number
  status?: string
  evidence?: string
  target?: string
  gained?: string
  agent?: string
}> = {
  name: 'redteam_vuln_add',
  description:
    '漏洞落库。落之前先用 redteam_vuln_query 查一遍，已经有人测过就别重复劳动。' +
    'evidence 必须写能复现的东西（回显片段、状态码、命令输出），标题不能当证据用。',
  schema: z.object({
    assetId: z.number().int().optional(),
    title: z.string().min(1).describe('漏洞标题（组件 + 类型 + 位置）'),
    cve: z.string().optional(),
    severity: z.string().optional().describe('critical / high / medium / low / info'),
    source: z.string().optional().describe('怎么发现的，如 nuclei / 手工 / 前端接口'),
    confidence: z.number().optional(),
    status: z.string().optional().describe('suspected / confirmed / exploited / false-positive'),
    evidence: z.string().optional().describe('证据原文'),
    target: z.string().optional().describe('具体目标 URL 或 host:port'),
    gained: z.string().optional().describe('由此拿到了什么'),
    agent: z.string().optional().describe('发现者角色')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const id = addVuln(input)
      return ok({ ok: true, vulnId: id })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '漏洞落库失败')
    }
  }
}

export const vulnQueryTool: Tool<{
  assetId?: number
  severity?: string
  status?: string
  cve?: string
  target?: string
  keyword?: string
  limit?: number
}> = {
  name: 'redteam_vuln_query',
  description: '查漏洞库。开工前先查重，指挥核对成果时也用它确认漏洞状态与证据。',
  schema: z.object({
    assetId: z.number().int().optional(),
    severity: z.string().optional(),
    status: z.string().optional(),
    cve: z.string().optional(),
    target: z.string().optional(),
    keyword: z.string().optional().describe('标题/证据关键词'),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = queryVulns(input)
    return ok({ count: rows.length, vulns: rows })
  }
}

export const vulnUpdateTool: Tool<{
  id: number
  status?: string
  severity?: string
  evidence?: string
  gained?: string
  cve?: string
  title?: string
  confidence?: number
}> = {
  name: 'redteam_vuln_update',
  description: '更新漏洞状态或补齐证据。验证成功把 status 改成 confirmed，打不动的标 false-positive。',
  schema: z.object({
    id: z.number().int(),
    status: z.string().optional(),
    severity: z.string().optional(),
    evidence: z.string().optional(),
    gained: z.string().optional(),
    cve: z.string().optional(),
    title: z.string().optional(),
    confidence: z.number().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    const { id, ...patch } = input
    return updateVuln(id, patch) ? ok({ ok: true, id }) : fail(`漏洞不存在：${id}`)
  }
}

// ---------------------------------------------------------------- 凭据 / 访问 / WebShell / 隧道

export const credentialAddTool: Tool<{
  assetId?: number
  host?: string
  username?: string
  secretType?: string
  secretValue?: string
  secretRef?: string
  privilege?: string
  source?: string
  tool?: string
  note?: string
  agent?: string
}> = {
  name: 'redteam_credential_add',
  description:
    '凭据落库（账号密码/密钥/哈希）。注意：只有凭据不算拿到账号权限 —— ' +
    '必须实测登录成功才能记 score_hit 的账号类得分，未验证的写 note 注明「未验证」。',
  schema: z.object({
    assetId: z.number().int().optional(),
    host: z.string().optional(),
    username: z.string().optional(),
    secretType: z.string().optional().describe('password / hash / key / token'),
    secretValue: z.string().optional().describe('明文口令或密钥（仅本机库，勿外传）'),
    secretRef: z.string().optional().describe('证据文件路径'),
    privilege: z.string().optional().describe('user / admin / root / system'),
    source: z.string().optional(),
    tool: z.string().optional(),
    note: z.string().optional(),
    agent: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, credentialId: addCredential(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '凭据落库失败')
    }
  }
}

export const credentialListTool: Tool<{ assetId?: number; host?: string; limit?: number }> = {
  name: 'redteam_credential_list',
  description: '列出已拿到的凭据（含明文 secret_value），用于凭据复用与横向移动。',
  schema: z.object({
    assetId: z.number().int().optional(),
    host: z.string().optional().describe('主机模糊匹配'),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = listCredentials(input.assetId, input.host, Math.min(Number(input.limit) || 100, 500))
    return ok({ count: rows.length, credentials: rows })
  }
}

export const accessAddTool: Tool<{
  assetId?: number
  host?: string
  username?: string
  method?: string
  privilege?: string
  sessionRef?: string
  note?: string
  agent?: string
}> = {
  name: 'redteam_access_add',
  description: '记录一次可控访问会话（横向移动的起点）：怎么进去的、什么权限。',
  schema: z.object({
    assetId: z.number().int().optional(),
    host: z.string().optional(),
    username: z.string().optional(),
    method: z.string().optional().describe('rdp / ssh / web-login / db / console'),
    privilege: z.string().optional(),
    sessionRef: z.string().optional(),
    note: z.string().optional(),
    agent: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, accessId: addAccess(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '访问会话落库失败')
    }
  }
}

export const webshellAddTool: Tool<{
  assetId?: number
  url: string
  shellType?: string
  passKey?: string
  secretRef?: string
  privilege?: string
  status?: string
  note?: string
  agent?: string
}> = {
  name: 'redteam_webshell_add',
  description:
    'WebShell 落库。必须写清马的类型（冰蝎/哥斯拉/蚁剑等）与实测是否连得上 —— ' +
    '用户能连上才算入口，只是传上去了不算。',
  schema: z.object({
    assetId: z.number().int().optional(),
    url: z.string().min(1),
    shellType: z.string().optional().describe('behinder（冰蝎）/ godzilla（哥斯拉）/ antsword / custom'),
    passKey: z.string().optional(),
    secretRef: z.string().optional(),
    privilege: z.string().optional(),
    status: z.string().optional().describe('active / dead / unknown'),
    note: z.string().optional(),
    agent: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, webshellId: addWebshell(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'WebShell 落库失败')
    }
  }
}

export const webshellListTool: Tool<{ assetId?: number; limit?: number }> = {
  name: 'redteam_webshell_list',
  description: '列出已上线的 WebShell，避免「打到最后忘了还有马」。',
  schema: z.object({
    assetId: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = listWebshells(input.assetId, Math.min(Number(input.limit) || 100, 500))
    return ok({ count: rows.length, webshells: rows })
  }
}

export const webshellUpdateTool: Tool<{
  id: number
  status?: string
  note?: string
  latencyMs?: number
  privilege?: string
}> = {
  name: 'redteam_webshell_update',
  description: '更新 WebShell 实测结果（是否能连、延迟、权限）。实测不通就改 dead。',
  schema: z.object({
    id: z.number().int(),
    status: z.string().optional(),
    note: z.string().optional(),
    latencyMs: z.number().int().optional(),
    privilege: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    const { id, ...patch } = input
    return updateWebshell(id, patch) ? ok({ ok: true, id }) : fail(`WebShell 不存在：${id}`)
  }
}

export const tunnelAddTool: Tool<{
  assetId?: number
  webshellId?: number
  kind?: string
  listen?: string
  entry?: string
  reach?: string
  entryKind?: string
  status?: string
  command?: string
  pid?: string
  note?: string
  agent?: string
}> = {
  name: 'redteam_tunnel_add',
  description:
    '内网隧道落库（suo5 / frp / chisel / ssh -R 等）。entry_kind 必须写清目标侧那一端：' +
    'target-outbound / target-http / target-agent / self-only。' +
    '只在自己 VPS 上开的代理是 self-only，不算边界突破，也不会计入突破类得分。',
  schema: z.object({
    assetId: z.number().int().optional(),
    webshellId: z.number().int().optional(),
    kind: z.string().optional().describe('suo5 / frp / chisel / ssh / regeorg'),
    listen: z.string().optional().describe('本地监听地址，如 socks5://127.0.0.1:1080'),
    entry: z.string().optional().describe('目标侧入口'),
    reach: z.string().optional().describe('可达网段/目标'),
    entryKind: z
      .enum(['target-outbound', 'target-http', 'target-agent', 'self-only'])
      .optional()
      .describe(
        '目标侧那一端：target-outbound 目标主动连出 / target-http 经 WebShell / target-agent 经已控会话 / self-only 只在自己 VPS'
      ),
    status: z.string().optional().describe('active / dead / unknown'),
    command: z.string().optional().describe('建立隧道用的原始命令，报告要复现'),
    pid: z.string().optional(),
    note: z.string().optional(),
    agent: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const { id, legit } = addTunnel(input)
      return ok({
        ok: true,
        tunnelId: id,
        legit,
        hint:
          legit === false
            ? '这条隧道记成 self-only：只在你自己的 VPS 上，没跨越靶标边界，不算突破。'
            : legit === null
              ? '未声明 entry_kind，界面按「待确认」显示，也不会被当成突破。建议补上。'
              : '已记录为跨越靶标边界。'
      })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '隧道落库失败')
    }
  }
}

export const tunnelListTool: Tool<{ assetId?: number; limit?: number }> = {
  name: 'redteam_tunnel_list',
  description: '列出隧道及其 entry_kind 判定（litgit=false 表示只在自己 VPS 上，不算突破）。',
  schema: z.object({
    assetId: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = listTunnels(input.assetId, Math.min(Number(input.limit) || 100, 500))
    return ok({
      count: rows.length,
      entryKinds: TUNNEL_ENTRY_KINDS,
      tunnels: rows
    })
  }
}

export const tunnelUpdateTool: Tool<{
  id: number
  status?: string
  reach?: string
  note?: string
  latencyMs?: number
  entryKind?: string
}> = {
  name: 'redteam_tunnel_update',
  description: '更新隧道状态与可达范围。打通新网段就更新 reach，断了的改 dead。',
  schema: z.object({
    id: z.number().int(),
    status: z.string().optional(),
    reach: z.string().optional(),
    note: z.string().optional(),
    latencyMs: z.number().int().optional(),
    entryKind: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    const { id, ...patch } = input
    return updateTunnel(id, patch) ? ok({ ok: true, id }) : fail(`隧道不存在：${id}`)
  }
}

// ---------------------------------------------------------------- 证据 / 攻击链

export const httpEvidenceAddTool: Tool<{
  vulnId?: number
  assetId?: number
  label?: string
  method?: string
  url?: string
  status?: number
  request?: string
  response?: string
  note?: string
  capturedBy?: string
}> = {
  name: 'redteam_http_evidence_add',
  description:
    '存原始请求/响应，能直接粘进 Burp / Yakit 复现。报告里的「怎么拿到的」靠它。' +
    '只存验证有效的那一份，不要存一堆扫出来的噪声。',
  schema: z.object({
    vulnId: z.number().int().optional(),
    assetId: z.number().int().optional(),
    label: z.string().optional(),
    method: z.string().optional(),
    url: z.string().optional(),
    status: z.number().int().optional(),
    request: z.string().optional().describe('原始请求全文'),
    response: z.string().optional().describe('关键响应片段'),
    note: z.string().optional(),
    capturedBy: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, evidenceId: addHttpEvidence(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '证据落库失败')
    }
  }
}

export const chainAddTool: Tool<{
  title: string
  stage?: string
  detail?: string
  assetId?: number
  vulnId?: number
  accessId?: number
  pointId?: number
  evidenceRef?: string
  tool?: string
  agent?: string
  result?: string
  recordedBy?: string
}> = {
  name: 'redteam_chain_add',
  description:
    '记录一个攻击链步骤。tool 与 result 是这一步的凭证 —— 报告要写清账号密码怎么来的、' +
    '隧道怎么搭的，全靠这两列的命令原文。缺了这一步报告交不出去。',
  schema: z.object({
    title: z.string().min(1).describe('这一步干了什么'),
    stage: z.string().optional().describe('recon / assess / vuln-scan / exploit / internal'),
    detail: z.string().optional(),
    assetId: z.number().int().optional(),
    vulnId: z.number().int().optional(),
    accessId: z.number().int().optional(),
    pointId: z.number().int().optional(),
    evidenceRef: z.string().optional(),
    tool: z.string().optional().describe('用了什么工具/命令（原文）'),
    agent: z.string().optional(),
    result: z.string().optional().describe('结果/回显'),
    recordedBy: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, stepId: addStep(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '步骤落库失败')
    }
  }
}

export const chainListTool: Tool<{ assetId?: number; limit?: number }> = {
  name: 'redteam_chain',
  description: '读攻击链步骤。指挥核对「有没有写实际命令」时用它 —— 没有 tool/result 的步骤不算成果。',
  schema: z.object({
    assetId: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = listSteps(input.assetId, Math.min(Number(input.limit) || 100, 500))
    return ok({ count: rows.length, steps: rows })
  }
}

// ---------------------------------------------------------------- 计分 / 报告

export const scoreListTool: Tool<Record<string, never>> = {
  name: 'redteam_score_list',
  description:
    '读得分表：每个内置得分点的规则号/档位/单次分值/累计上限/去重口径，以及当前总分与满分。' +
    '汇报成绩只能报这里的真实数字，不要估。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    const board = scoreBoard()
    const points = scorePointsMap()
    return ok({
      total: board.total,
      max: board.maxTotal,
      counted: board.counted,
      hits: board.all,
      points: [...points.values()].map((p) => ({
        code: p.code,
        name: p.name,
        rule: p.rule,
        tier: p.tier,
        points: p.points,
        cap: p.cap,
        dedupScope: p.dedup_scope
      })),
      rows: board.rows.map((r) => ({
        id: r.id,
        code: r.code,
        points: r.effective,
        capped: r.capped,
        cappedBy: r.capped_reason_kind,
        target: r.target,
        selfCreated: Number(r.self_created) === 1
      }))
    })
  }
}

export const scoreHitTool: Tool<{
  code: string
  assetId?: number
  vulnId?: number
  stepId?: number
  target?: string
  evidence?: string
  note?: string
  selfCreated?: boolean
  port?: number
  points?: number
  multiplier?: number
  recordedBy?: string
}> = {
  name: 'redteam_score_hit',
  description:
    '记一次得分。三个红线：① 自己注册/自建的账号必须 selfCreated=true（永不计分，只留痕）；' +
    '② 同一服务的同档权限只算一次，重复记会被自动去重；③ 单次分值要按档位调整（如普通权限 10 分传给 points=10）。',
  schema: z.object({
    code: z.string().min(1).describe('得分点 code，从 redteam_score_list 拿'),
    assetId: z.number().int().optional(),
    vulnId: z.number().int().optional(),
    stepId: z.number().int().optional(),
    target: z.string().optional().describe('具体目标，用于服务级去重'),
    evidence: z.string().optional().describe('成果证据，报告要引用'),
    note: z.string().optional(),
    selfCreated: z.boolean().optional().describe('是否自己注册/自建的账号（true 则不计分）'),
    port: z.number().int().optional(),
    points: z.number().int().optional().describe('本次实际分值（档位不同时调整）'),
    multiplier: z.number().optional().describe('倍率：数据规模翻倍 ×2、IPv6 成果 ×3'),
    recordedBy: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const r = addScoreHit(input)
      return ok({ ok: true, hitId: r.id, pointCode: r.pointCode, points: r.points })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '记分失败')
    }
  }
}

export const reportTool: Tool<{ includeCredentials?: boolean }> = {
  name: 'redteam_report',
  description:
    '生成 Markdown 演练报告：得分（含封顶/去重说明）、资产统计、漏洞、入口（WebShell/隧道）、攻击链步骤。' +
    '只收录真正拿到的东西；报告里每条都要能复现（目标 → 拿到什么 → 怎么拿到的）。',
  schema: z.object({
    includeCredentials: z.boolean().optional().describe('是否在报告里带出凭据明文（默认 false）')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const eng = currentEngagement()
    const board = scoreBoard()
    const stats = assetStats()
    const vulns = queryVulns({ limit: 200 })
    const shells = listWebshells(undefined, 100)
    const tunnels = listTunnels(undefined, 100)
    const steps = listSteps(undefined, 200)
    const creds = input.includeCredentials ? listCredentials(undefined, undefined, 100) : []

    const lines: string[] = []
    lines.push(`# 红队演练报告${eng ? ` · ${eng.name}` : ''}`)
    lines.push('')
    if (eng?.scope) lines.push(`**授权范围**：${eng.scope}`)
    lines.push(`**生成时间**：${new Date().toISOString()}`)
    lines.push('')
    lines.push('## 一、得分')
    lines.push('')
    lines.push(`- 总分：**${board.total}** / 上限合计 ${board.maxTotal}`)
    lines.push(`- 计分命中 ${board.counted} 条（共记录 ${board.all} 条，被封顶/去重的不计分）`)
    lines.push('')
    if (board.rows.length > 0) {
      lines.push('| 得分点 | 分值 | 目标 | 状态 |')
      lines.push('| --- | --- | --- | --- |')
      for (const r of board.rows) {
        const state =
          Number(r.self_created) === 1
            ? '自建账号，不计分'
            : r.capped
              ? r.capped_reason_kind === 'dedup'
                ? '同口径已计分（去重）'
                : '超出规则上限（封顶）'
              : '计分'
        lines.push(`| ${r.code} | ${r.effective} | ${r.target ?? '-'} | ${state} |`)
      }
      lines.push('')
    }
    lines.push('## 二、资产测绘')
    lines.push('')
    lines.push(`- 资产总数：${stats.total}，开放端口：${stats.openPorts}，域名记录：${stats.names}`)
    lines.push('')
    lines.push('## 三、漏洞')
    lines.push('')
    if (vulns.length === 0) lines.push('（无）')
    else {
      lines.push('| ID | 标题 | 严重度 | 状态 | 目标 |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const v of vulns) {
        lines.push(
          `| ${v.id} | ${v.title} | ${v.severity ?? '-'} | ${v.status ?? '-'} | ${v.target ?? '-'} |`
        )
      }
    }
    lines.push('')
    lines.push('## 四、入口与通道')
    lines.push('')
    lines.push(`### WebShell（${shells.length}）`)
    if (shells.length === 0) lines.push('（无）')
    else {
      for (const s of shells) {
        lines.push(
          `- ${s.url} · ${s.shell_type ?? '未知类型'} · 状态 ${s.status ?? 'unknown'} · 权限 ${s.privilege ?? '-'}`
        )
      }
    }
    lines.push('')
    lines.push(`### 隧道（${tunnels.length}）`)
    if (tunnels.length === 0) lines.push('（无）')
    else {
      for (const t of tunnels) {
        const legit = t.legit === false ? '（self-only，不算突破）' : t.legit === null ? '（entry_kind 未声明）' : ''
        lines.push(`- ${t.listen ?? t.entry ?? '-'} · ${t.kind ?? '-'} · 可达 ${t.reach ?? '-'}${legit}`)
      }
    }
    if (creds.length > 0) {
      lines.push('')
      lines.push(`### 凭据（${creds.length}）`)
      for (const c of creds) {
        lines.push(`- ${c.host ?? '-'} · ${c.username ?? '-'} / ${c.secret_value ?? '-'} · ${c.privilege ?? '-'}`)
      }
    }
    lines.push('')
    lines.push('## 五、攻击链')
    lines.push('')
    if (steps.length === 0) lines.push('（无）')
    else {
      for (const s of steps) {
        lines.push(`### ${s.seq}. ${s.title}`)
        if (s.stage) lines.push(`- 阶段：${s.stage}`)
        if (s.tool) lines.push(`- 工具/命令：\`${s.tool}\``)
        if (s.result) lines.push(`- 结果：${s.result}`)
        if (s.detail) lines.push(`- 说明：${s.detail}`)
        lines.push('')
      }
    }
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('> 本报告只收录已实际验证的成果；未落库的发现不计入。凭据与隧道明细仅本机留存，勿外传。')
    return ok(lines.join('\n'))
  }
}

// ---------------------------------------------------------------- 会话 / 靶标绑定

export const sessionBindTool: Tool<{ name?: string; listOnly?: boolean }> = {
  name: 'redteam_session_bind',
  description:
    '把一个已存在的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。' +
    '省略 name 时只列出候选靶标。子智能体会自动继承父会话的绑定，不要在子任务里改绑。',
  schema: z.object({
    name: z.string().optional().describe('靶标 id 或单位名称；省略只列出候选'),
    listOnly: z.boolean().optional().describe('只列候选，不切换')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    const all = listEngagements()
    if (input.listOnly || !input.name?.trim()) {
      return ok({ current: currentEngagement(), engagements: all })
    }
    const target = all.find((e) => e.id === input.name!.trim() || e.name === input.name!.trim())
    if (!target) return fail(`靶标不存在：${input.name}。可用：${all.map((e) => e.id).join(', ') || '（无）'}`)
    return setActiveEngagement(target.id)
      ? ok({ ok: true, current: target })
      : fail('切换靶标失败')
  }
}

// ---------------------------------------------------------------- 并发闸

export const agentSlotTool: Tool<{ action: 'status' | 'acquire' | 'release'; label?: string; key?: string }> = {
  name: 'redteam_agent_slot',
  description:
    '【主会话派活前后用】执行智能体的并发闸门：同一靶标最多同时 3 个在跑。' +
    '派活前 action=acquire 占位，子智能体回报后 action=release 释放。被拒绝就是满了，' +
    '不要重试硬塞，等现有的回报再派。',
  schema: z.object({
    action: z.enum(['status', 'acquire', 'release']).describe('status 查看 / acquire 占用 / release 释放'),
    label: z.string().optional().describe('acquire 时的任务标签，例如「信息收集：主域与 C 段」'),
    key: z.string().optional().describe('release 时指定要释放的键（省略则释放最早的一个）')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok(agentSlot(input.action, input.label, input.key))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '并发闸操作失败')
    }
  }
}

// ---------------------------------------------------------------- 资产（上游参数形态）

const upstreamPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  proto: z.string().optional(),
  service: z.string().optional(),
  product: z.string().optional(),
  version: z.string().optional(),
  banner: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  provenance: z.enum(['passive', 'active']).optional(),
  tool: z.string().optional(),
  fingerprints: z
    .array(
      z.object({
        category: z.string().optional(),
        vendor: z.string().optional(),
        product: z.string().optional(),
        version: z.string().optional(),
        evidence: z.string().optional(),
        confidence: z.number().optional()
      })
    )
    .optional()
})

export const assetAddTool: Tool<{
  ip: string
  provenance: 'passive' | 'active'
  state?: string
  primary_name?: string
  tool?: string
  discovered_at?: string
  first_seen?: string
  segment?: string
  names?: Array<{ name: string; kind?: string; provenance?: 'passive' | 'active' }>
  ports?: Array<z.infer<typeof upstreamPortSchema>>
}> = {
  name: 'redteam_asset_add',
  description:
    '把一个资产及其端口/服务/指纹写入资产库（幂等 upsert，与 redteam_asset_upsert 等价，' +
    '参数按上游原版命名）。每条发现必须标注 provenance：被动收集还是主动探测。' +
    '收完资产一定要落库——没落库的发现等于没发生。',
  schema: z.object({
    ip: z.string().min(1).describe('资产 IP（IPv4）'),
    provenance: z.enum(['passive', 'active']).describe('本条发现的来源：被动或主动'),
    state: z.string().optional().describe('live | dead | unknown'),
    primary_name: z.string().optional().describe('主域名/主机名'),
    tool: z.string().optional().describe('数据源或工具名，如 crt.sh / nmap / fscan'),
    discovered_at: z.string().optional().describe('这条资产的发现时间（ISO）；重复采集不会覆盖'),
    first_seen: z.string().optional().describe('数据源报告的首次出现时间'),
    segment: z.string().optional().describe('所属网段（CIDR），不填按 /24 推导'),
    names: z.array(z.object({ name: z.string(), kind: z.string().optional(), provenance: z.enum(['passive', 'active']).optional() })).optional(),
    ports: z.array(upstreamPortSchema).optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const { asset, created } = upsertAsset({
        ip: input.ip,
        segment: input.segment,
        state: input.state,
        primaryName: input.primary_name,
        provenance: input.provenance,
        tool: input.tool,
        discoveredAt: input.discovered_at,
        firstSeen: input.first_seen,
        names: input.names,
        ports: input.ports
      })
      return ok({ ok: true, created, asset })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '资产落库失败')
    }
  }
}

export const assetGetTool: Tool<{ id: number }> = {
  name: 'redteam_asset_get',
  description:
    '取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。',
  schema: z.object({
    id: z.number().int().describe('资产 id（来自 redteam_asset_query 结果）')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const detail = getAssetDetail(input.id)
    return detail ? ok(detail) : fail(`资产不存在：${input.id}`)
  }
}

export const assetLinkTool: Tool<{
  src_kind: string
  src_id: string
  dst_kind: string
  dst_id: string
  relation: string
  confidence?: number
}> = {
  name: 'redteam_asset_link',
  description:
    '在资产库写一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / ' +
    'part-of / reaches。同一条边重复写会幂等去重。',
  schema: z.object({
    src_kind: z.string().min(1).describe('segment | asset | domain | port …'),
    src_id: z.string().min(1),
    dst_kind: z.string().min(1),
    dst_id: z.string().min(1),
    relation: z.string().min(1),
    confidence: z.number().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const id = linkAssets({
        srcKind: input.src_kind,
        srcId: input.src_id,
        dstKind: input.dst_kind,
        dstId: input.dst_id,
        relation: input.relation,
        confidence: input.confidence
      })
      return ok({ ok: true, edgeId: id })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '关系边写入失败')
    }
  }
}

export const assetGraphTool: Tool<{ cidr?: string; maxNodes?: number }> = {
  name: 'redteam_asset_graph',
  description:
    '导出资产图谱（网段 → 资产 → 开放端口，含域名与关系边），用于拓扑推理与横向移动路径规划。' +
    '节点数超过上限时按 C 段缩小范围。',
  schema: z.object({
    cidr: z.string().optional().describe('只取某个 C 段的子图'),
    maxNodes: z.number().int().optional().describe('节点上限，默认 300')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      return ok(assetGraph(input.cidr, Math.min(Number(input.maxNodes) || 300, 2000)))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '图谱导出失败')
    }
  }
}

export const assetTimelineTool: Tool<{ limit?: number }> = {
  name: 'redteam_asset_timeline',
  description: '资产「发现时间」视图：按天聚合哪天收了多少资产，并列出最近发现的资产。',
  schema: z.object({
    limit: z.number().int().optional().describe('最近资产条数，默认 50')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      return ok(assetTimeline(Math.min(Number(input.limit) || 50, 500)))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '时间线读取失败')
    }
  }
}

// ---------------------------------------------------------------- 角色

export const rolesTool: Tool<Record<string, never>> = {
  name: 'redteam_roles',
  description:
    '列出红队六个角色及其职责标题（主会话指挥 / 信息收集 / 资产梳理 / 漏洞发现 / 漏洞利用 / 内网渗透）。' +
    '派活时子 Agent 的 subagentType 用 redteam-<code>。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    return ok({
      roles: Object.entries(REDTEAM_ROLE_LABELS).map(([code, label]) => ({
        code,
        label,
        subagentType: code === 'plan' ? '(主会话自身，不派出)' : `redteam-${code}`,
        dispatchable: code !== 'plan'
      }))
    })
  }
}

export const rolePromptTool: Tool<{ role: string }> = {
  name: 'redteam_role_prompt',
  description:
    '取出某个角色当前生效的系统提示词，只供查看。派活时不要把全文抄进任务 —— ' +
    '子 Agent 的提示词已经内置，抄一遍只是白烧 token。',
  schema: z.object({
    role: z.enum(['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal']).describe('角色 code')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const r = readRolePrompt(input.role)
      return ok({ role: input.role, source: r.source, chars: r.text.length, text: r.text })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取角色提示词失败')
    }
  }
}

export const rolePromptResetTool: Tool<{ role: string }> = {
  name: 'redteam_role_prompt_reset',
  description: '把角色系统提示词恢复为内置默认（删掉本靶标下的覆盖文件）。',
  schema: z.object({
    role: z.enum(['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal']).describe('角色 code')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return resetRolePrompt(input.role)
        ? ok({ ok: true, role: input.role, source: 'builtin' })
        : fail('恢复失败')
    } catch (e) {
      return fail(e instanceof Error ? e.message : '恢复角色提示词失败')
    }
  }
}

// ---------------------------------------------------------------- 总览 / 连通性

export const sessionsTool: Tool<Record<string, never>> = {
  name: 'redteam_sessions',
  description:
    '【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道' +
    '（含监听地址与可达网段、是否跨越靶标边界）、已拿到的凭据、访问会话与得分进度。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    try {
      return ok(sessionsOverview())
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取会话总览失败')
    }
  }
}

export const sessionCheckTool: Tool<{ timeoutMs?: number }> = {
  name: 'redteam_session_check',
  description:
    '实测所有 WebShell 与隧道的连通性（真实发起 HTTP GET / TCP connect），并把在线/失效状态' +
    '回写库里。只探测你自己登记过的入口地址。注意：这是唯一会主动出网的工具。',
  schema: z.object({
    timeoutMs: z.number().int().optional().describe('单次探测超时，默认 6000ms')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok(await sessionCheck(input.timeoutMs))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '连通性实测失败')
    }
  }
}

export const accessListTool: Tool<{ host?: string; limit?: number }> = {
  name: 'redteam_access_list',
  description: '列出已获得的访问会话（横向移动起点）：支持按主机筛选，含登录方式与权限级别。',
  schema: z.object({
    host: z.string().optional().describe('主机模糊匹配'),
    limit: z.number().int().min(1).max(500).optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const rows = listAccess(input.host, Math.min(Number(input.limit) || 100, 500))
    return ok({ count: rows.length, accessSessions: rows })
  }
}

// ---------------------------------------------------------------- 证据截图

export const shotAddTool: Tool<{
  path?: string
  data_base64?: string
  label?: string
  kind?: string
  point_code?: string
  hit_id?: number
  asset_id?: number
  target?: string
  note?: string
  source_ref?: string
  captured_at?: string
  agent?: string
}> = {
  name: 'redteam_shot_add',
  description:
    '登记一张证据截图：把图片拷进靶标目录的 shots/ 并关联到得分点/命中。' +
    'kind 必须区分 screenshot（现场截图）与 card（由记录生成的摘录卡）—— 混在一起交付时说不清。',
  schema: z.object({
    path: z.string().optional().describe('图片在本机的路径；与 data_base64 二选一'),
    data_base64: z.string().optional().describe('图片内容（base64，可带 data: 前缀）'),
    label: z.string().optional().describe('图片说明'),
    kind: z.string().optional().describe('screenshot（默认）| card'),
    point_code: z.string().optional().describe('关联的得分点 code'),
    hit_id: z.number().int().optional().describe('关联到具体某条得分命中'),
    asset_id: z.number().int().optional(),
    target: z.string().optional(),
    note: z.string().optional().describe('这张图证明了什么'),
    source_ref: z.string().optional(),
    captured_at: z.string().optional(),
    agent: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, ...addShot(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '截图登记失败')
    }
  }
}

export const shotListTool: Tool<{ point_code?: string; hit_id?: number; asset_id?: number }> = {
  name: 'redteam_shot_list',
  description: '列出已登记的证据截图（含所属得分点、目标、类型、落盘文件绝对路径）。',
  schema: z.object({
    point_code: z.string().optional(),
    hit_id: z.number().int().optional(),
    asset_id: z.number().int().optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const rows = listShots({
        pointCode: input.point_code,
        hitId: input.hit_id,
        assetId: input.asset_id
      })
      return ok({ count: rows.length, shots: rows })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取截图列表失败')
    }
  }
}

export const shotDeleteTool: Tool<{ id: number }> = {
  name: 'redteam_shot_delete',
  description: '删除一张证据截图（连同磁盘文件）。会让报告里对它的引用失效，慎用。',
  schema: z.object({ id: z.number().int().describe('shot id') }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return deleteShot(input.id) ? ok({ ok: true, id: input.id }) : fail(`截图不存在：${input.id}`)
    } catch (e) {
      return fail(e instanceof Error ? e.message : '删除截图失败')
    }
  }
}

// ---------------------------------------------------------------- Web / 域名 / 图谱

export const webListTool: Tool<{ cidr?: string; limit?: number }> = {
  name: 'redteam_web_list',
  description:
    '列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。',
  schema: z.object({
    cidr: z.string().optional(),
    limit: z.number().int().optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const rows = webList(input.cidr, Math.min(Number(input.limit) || 200, 500))
      return ok({ count: rows.length, web: rows })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取 Web 资产失败')
    }
  }
}

export const domainIndexTool: Tool<Record<string, never>> = {
  name: 'redteam_domain_index',
  description: '按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域、子域与 C 段的关系。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    try {
      const rows = domainIndex()
      return ok({ count: rows.length, domains: rows })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取域名索引失败')
    }
  }
}

export const attackPathTool: Tool<{ cidr?: string; maxNodes?: number }> = {
  name: 'redteam_attack_path',
  description:
    '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（owned 标记）。用于横向移动路径规划与战果汇报。',
  schema: z.object({
    cidr: z.string().optional(),
    maxNodes: z.number().int().optional().describe('默认 400')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      return ok(attackPath(input.cidr, Math.min(Number(input.maxNodes) || 400, 2000)))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '攻击图谱导出失败')
    }
  }
}

export const attackChainTool: Tool<Record<string, never>> = {
  name: 'redteam_attack_chain',
  description:
    '攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ' +
    '③ 边界突破 → ④ 内网资产权限 → ⑤ 靶标权限。空阶段也保留编号，方便看链路缺哪一环。',
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    try {
      return ok(attackChainView())
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取攻击链失败')
    }
  }
}

// ---------------------------------------------------------------- 攻击文件

export const attackFileAddTool: Tool<{
  target: string
  name: string
  evidence: string
  kind?: string
  description?: string
  content?: string
  path?: string
  asset_id?: number
  vuln_id?: number
  created_by?: string
}> = {
  name: 'redteam_attack_file_add',
  description:
    '保存一个实际生效的攻击文件（脚本/POC/EXP/字典）到 <靶标>/attack-files/<目标>/，供复用与交付。' +
    'evidence 必填：只收录实际打通验证过的，不要存一堆没跑通的脚本。',
  schema: z.object({
    target: z.string().min(1).describe('目标：IP、URL 或 C 段'),
    name: z.string().min(1).describe('文件名，如 cve-2021-22893.sh'),
    evidence: z.string().min(1).describe('有效性证据：实际打通的输出/回显'),
    kind: z.enum(['poc', 'exp', 'script', 'wordlist', 'other']).optional(),
    description: z.string().optional(),
    content: z.string().optional().describe('文件内容（与 path 二选一）'),
    path: z.string().optional().describe('已存在的文件路径（与 content 二选一）'),
    asset_id: z.number().int().optional(),
    vuln_id: z.number().int().optional(),
    created_by: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, ...addAttackFile(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '攻击文件保存失败')
    }
  }
}

export const attackFileListTool: Tool<{ target?: string }> = {
  name: 'redteam_attack_file_list',
  description: '列出已保存的攻击文件（按目标文件夹）。开始打某个目标前先看这里，避免重复造轮子。',
  schema: z.object({ target: z.string().optional().describe('只看某个目标') }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const rows = listAttackFiles(input.target)
      return ok({ count: rows.length, files: rows })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取攻击文件失败')
    }
  }
}

// ---------------------------------------------------------------- 计分扩展 / 报告

export const scorePointSaveTool: Tool<{
  name: string
  id?: number
  code?: string
  category?: string
  points?: number
  description?: string
  enabled?: boolean
}> = {
  name: 'redteam_score_point_save',
  description:
    '新增或修改得分点（分值/名称/分类/说明/启用）。内置得分点的分值、上限、去重口径由规则锁定，' +
    '只允许改启用状态 —— 改分值会让总分对不上规则。',
  schema: z.object({
    name: z.string().min(1),
    id: z.number().int().optional().describe('已有得分点 id（修改时传）'),
    code: z.string().optional().describe('短代码（新增时建议给，便于记分）'),
    category: z.string().optional(),
    points: z.number().int().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      return ok({ ok: true, ...saveScorePoint(input) })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '保存得分点失败')
    }
  }
}

export const scoreReportTool: Tool<{ limit?: number; markdown?: boolean }> = {
  name: 'redteam_score_report',
  description:
    '攻击得分链路复现报告（Markdown）：只收录拿到分的成果，并单列被封顶/去重/自建账号未计分的记录及原因。' +
    'markdown=false 时只返回条目摘要（省 token）。',
  schema: z.object({
    limit: z.number().int().optional().describe('最多多少项，默认 500'),
    markdown: z.boolean().optional().describe('true=返回 markdown 全文（默认 true）')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const r = scoreReport(Math.min(Number(input.limit) || 500, 2000))
      return ok(input.markdown === false ? { items: r.items } : { markdown: r.markdown, items: r.items })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '生成报告失败')
    }
  }
}

export const reportTargetsTool: Tool<{ target?: string }> = {
  name: 'redteam_report_targets',
  description: '按目标查看成果汇总（每个 IP / URL 拿了多少条、多少分）。',
  schema: z.object({ target: z.string().optional().describe('只看某个目标') }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      return ok(reportTargets(input.target))
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取目标汇总失败')
    }
  }
}

// ---------------------------------------------------------------- POC 知识库

export const pocSearchTool: Tool<{
  q?: string
  cve?: string
  component?: string
  kind?: string
  category?: string
  language?: string
  source?: string
  verified?: boolean
  engagement?: string
  asset_target?: string
  limit?: number
}> = {
  name: 'redteam_poc_search',
  description:
    '【打 Nday/1day 前的第一步】先查本机沉淀的通用 POC/EXP 知识库。' +
    '支持按组件、CVE、归类、验证状态等检索。知识库跨靶标共享。',
  schema: z.object({
    q: z.string().optional().describe('关键字：组件+版本、漏洞名、路径片段、正文特征串'),
    cve: z.string().optional(),
    component: z.string().optional().describe('组件/产品名，如 Weblogic、Shiro'),
    kind: z.string().optional().describe('poc | exp | script | template | payload'),
    category: z
      .string()
      .optional()
      .describe('归类，可多值逗号分隔：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other'),
    language: z.string().optional(),
    source: z.string().optional().describe('web | self | manual | nuclei-template'),
    verified: z.boolean().optional().describe('true 只看实测验证过的（优先用这些）'),
    engagement: z.string().optional().describe('按来源靶标筛'),
    asset_target: z.string().optional().describe('按发现资产筛'),
    limit: z.number().int().optional().describe('默认 200')
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const items = searchPocs(input)
      return ok({ count: items.length, stats: pocStats(), items })
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'POC 检索失败')
    }
  }
}

export const pocGetTool: Tool<{ id?: number; code?: string }> = {
  name: 'redteam_poc_get',
  description: '取一条知识库 POC/EXP 的完整内容（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改。',
  schema: z.object({
    id: z.number().int().optional(),
    code: z.string().optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      if (input.id == null && !input.code?.trim()) return fail('需要 id 或 code')
      const row = getPoc(input)
      return row ? ok(row) : fail('知识库条目不存在')
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取 POC 失败')
    }
  }
}

export const pocAddTool: Tool<{
  title: string
  kind?: string
  category?: string
  cve?: string
  component?: string
  versions?: string
  severity?: string
  language?: string
  source?: string
  source_url?: string
  description?: string
  usage?: string
  content?: string
  path?: string
  filename?: string
  verified?: boolean
  verified_note?: string
  engagement?: string
  asset_target?: string
  found_by_agent?: string
  tags?: string
  created_by?: string
}> = {
  name: 'redteam_poc_add',
  description:
    '把通用可复用的 POC/EXP 落进知识库（跨靶标共享，按标题生成稳定 code，同 code 幂等更新）。' +
    '建议填 category、engagement/asset_target（在哪个靶标哪台资产上验证的）、verified_note，' +
    '并脱敏掉本次靶标与内网专属信息。',
  schema: z.object({
    title: z.string().min(1).describe('标题：组件 + 漏洞名/编号'),
    kind: z.string().optional().describe('poc | exp | script | template | payload'),
    category: z.string().optional().describe('rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other'),
    cve: z.string().optional(),
    component: z.string().optional(),
    versions: z.string().optional(),
    severity: z.string().optional(),
    language: z.string().optional().describe('python | go | java | bash | http | nuclei | js | php'),
    source: z.string().optional().describe('web | self | manual | nuclei-template'),
    source_url: z.string().optional(),
    description: z.string().optional(),
    usage: z.string().optional().describe('完整命令行示例 + 需要替换的参数'),
    content: z.string().optional().describe('正文：脚本源码 / 原始请求包 / nuclei 模板'),
    path: z.string().optional().describe('或给本机已有文件路径'),
    filename: z.string().optional(),
    verified: z.boolean().optional().describe('只有在真实目标上验证过才填 true'),
    verified_note: z.string().optional().describe('验证证据：哪台目标、什么回显'),
    engagement: z.string().optional().describe('来源靶标'),
    asset_target: z.string().optional().describe('发现资产，如 10.1.2.3:8080'),
    found_by_agent: z.string().optional(),
    tags: z.string().optional(),
    created_by: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      const r = addPoc({
        title: input.title,
        kind: input.kind,
        category: input.category,
        cve: input.cve,
        component: input.component,
        versions: input.versions,
        severity: input.severity,
        language: input.language,
        source: input.source,
        sourceUrl: input.source_url,
        description: input.description,
        usage: input.usage,
        content: input.content,
        path: input.path,
        filename: input.filename,
        verified: input.verified,
        verifiedNote: input.verified_note,
        engagementName: input.engagement,
        assetTarget: input.asset_target,
        foundByAgent: input.found_by_agent,
        tags: input.tags,
        createdBy: input.created_by
      })
      return ok({ ok: true, ...r })
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'POC 落库失败')
    }
  }
}

export const pocListTool: Tool<{ kind?: string; source?: string; component?: string; verified?: boolean; limit?: number }> = {
  name: 'redteam_poc_list',
  description: '列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤）。',
  schema: z.object({
    kind: z.string().optional(),
    source: z.string().optional(),
    component: z.string().optional(),
    verified: z.boolean().optional(),
    limit: z.number().int().optional()
  }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    try {
      const items = searchPocs(input)
      return ok({ count: items.length, stats: pocStats(), items })
    } catch (e) {
      return fail(e instanceof Error ? e.message : '读取 POC 列表失败')
    }
  }
}

export const pocUpdateTool: Tool<{
  id?: number
  code?: string
  patch?: Record<string, unknown>
  verified?: boolean
  verified_note?: string
}> = {
  name: 'redteam_poc_update',
  description:
    '更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改归类。',
  schema: z.object({
    id: z.number().int().optional(),
    code: z.string().optional(),
    patch: z.record(z.string(), z.unknown()).optional().describe('要改的字段集合'),
    verified: z.boolean().optional(),
    verified_note: z.string().optional()
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      if (input.id == null && !input.code?.trim()) return fail('需要 id 或 code')
      const done = updatePoc(
        { id: input.id, code: input.code },
        input.patch ?? {},
        input.verified,
        input.verified_note
      )
      return done ? ok({ ok: true }) : fail('知识库条目不存在')
    } catch (e) {
      return fail(e instanceof Error ? e.message : '更新 POC 失败')
    }
  }
}

export const pocUseTool: Tool<{ id?: number; code?: string; used_on?: string }> = {
  name: 'redteam_poc_use',
  description: '记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面。',
  schema: z.object({
    id: z.number().int().optional(),
    code: z.string().optional(),
    used_on: z.string().optional().describe('用在哪：靶标名 / 目标 IP / URL')
  }),
  readOnly: false,
  concurrencySafe: false,
  permissionGroup: 'redteam',
  async execute(input): Promise<ToolResult> {
    try {
      if (input.id == null && !input.code?.trim()) return fail('需要 id 或 code')
      const done = markPocUsed({ id: input.id, code: input.code }, input.used_on ?? '')
      return done ? ok({ ok: true }) : fail('知识库条目不存在')
    } catch (e) {
      return fail(e instanceof Error ? e.message : '记录复用失败')
    }
  }
}

// ---------------------------------------------------------------- 注册

export const REDTEAM_TOOLS: Tool<never>[] = [
  // 靶标与会话
  engagementOpenTool,
  sessionBindTool,
  sessionInfoTool,
  sessionsTool,
  preflightTool,
  agentSlotTool,
  // 角色
  rolesTool,
  rolePromptTool,
  rolePromptResetTool,
  // 资产
  assetAddTool,
  assetUpsertTool,
  assetQueryTool,
  assetGetTool,
  assetStatsTool,
  assetAssessTool,
  assetTestTool,
  assetLinkTool,
  assetGraphTool,
  assetTimelineTool,
  // 漏洞
  vulnAddTool,
  vulnQueryTool,
  vulnUpdateTool,
  // 入口与通道
  credentialAddTool,
  credentialListTool,
  accessAddTool,
  accessListTool,
  webshellAddTool,
  webshellListTool,
  webshellUpdateTool,
  tunnelAddTool,
  tunnelListTool,
  tunnelUpdateTool,
  sessionCheckTool,
  // 证据与链路
  httpEvidenceAddTool,
  chainAddTool,
  chainListTool,
  attackChainTool,
  attackPathTool,
  attackFileAddTool,
  attackFileListTool,
  shotAddTool,
  shotListTool,
  shotDeleteTool,
  // 检索视图
  webListTool,
  domainIndexTool,
  // 计分与报告
  scoreListTool,
  scoreHitTool,
  scorePointSaveTool,
  scoreReportTool,
  reportTargetsTool,
  reportTool,
  // POC 知识库
  pocSearchTool,
  pocGetTool,
  pocAddTool,
  pocListTool,
  pocUpdateTool,
  pocUseTool
] as unknown as Tool<never>[]

/** 内置得分点总数，供设置页展示「已播种 N 个分项」。 */
export const BUILTIN_SCORE_POINT_COUNT = BUILTIN_SCORE_POINTS.length
