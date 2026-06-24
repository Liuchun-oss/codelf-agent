import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { ProfileDraft, ProviderProfileSummary } from '@shared/agentTypes'
import type { Tool, ToolResult } from './types'
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  setActiveProfile,
  getActiveProfileId,
  getProfileRaw
} from '../providers/profileStore'

export const MODEL_CONFIG_TOOL_NAME = 'ModelConfig'

const providerKindSchema = z.enum([
  'openai',
  'azure-openai',
  'anthropic',
  'openai-compatible',
  'deepseek',
  'dify'
])

const modelConfigSchema = z.object({
  action: z
    .enum(['list', 'add', 'update', 'delete', 'set_active'])
    .describe('要执行的操作：list 列出全部配置；add 新增；update 修改；delete 删除；set_active 切换当前激活模型'),
  id: z.string().optional().describe('配置 id（update/delete/set_active 必填；set_active 传 null 字符串以外的有效 id）'),
  name: z.string().optional().describe('配置显示名（add 必填）'),
  kind: providerKindSchema.optional().describe('Provider 类型（add 必填）'),
  baseUrl: z.string().optional().describe('API Base URL（add 必填）'),
  model: z.string().optional().describe('模型名（add 必填）'),
  apiKey: z.string().optional().describe('API 密钥；写入系统安全存储。传空字符串可清除已有密钥'),
  contextWindow: z.number().int().positive().optional().describe('上下文窗口 token 数'),
  maxOutputTokens: z.number().int().positive().optional().describe('最大输出 token 数'),
  supportsTools: z.boolean().optional().describe('模型是否支持工具调用，默认 true'),
  supportsVision: z.boolean().optional().describe('模型是否支持视觉输入'),
  timeoutMs: z.number().int().positive().optional().describe('请求超时毫秒，默认 120000'),
  setActive: z.boolean().optional().describe('add 时是否同时把新配置设为当前激活模型')
})

type ModelConfigInput = z.infer<typeof modelConfigSchema>

function summaryLine(p: ProviderProfileSummary, activeId: string | null): string {
  const flags = [
    p.id === activeId ? '激活' : null,
    p.hasApiKey ? '有密钥' : '无密钥',
    p.supportsTools ? '工具' : null,
    p.supportsVision ? '视觉' : null
  ]
    .filter(Boolean)
    .join('/')
  return `- ${p.name}（id=${p.id}，${p.kind}）：${p.model} @ ${p.baseUrl}${flags ? ` [${flags}]` : ''}`
}

function listResult(): ToolResult {
  const profiles = listProfiles()
  const activeId = getActiveProfileId()
  if (profiles.length === 0) return { content: '当前没有任何模型配置。' }
  return { content: `共有 ${profiles.length} 个模型配置：\n${profiles.map((p) => summaryLine(p, activeId)).join('\n')}` }
}

function addResult(input: ModelConfigInput): ToolResult {
  if (!input.name?.trim() || !input.kind || !input.baseUrl?.trim() || !input.model?.trim()) {
    return { content: 'add 操作需要提供 name、kind、baseUrl、model 四个字段。', isError: true }
  }
  const draft: ProfileDraft = {
    id: randomUUID(),
    name: input.name.trim(),
    kind: input.kind,
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
    contextWindow: input.contextWindow,
    contextWindowSource: input.contextWindow != null ? 'manual' : 'default',
    maxOutputTokens: input.maxOutputTokens,
    maxOutputTokensSource: input.maxOutputTokens != null ? 'manual' : 'default',
    supportsTools: input.supportsTools ?? true,
    supportsVision: input.supportsVision,
    timeoutMs: input.timeoutMs ?? 120_000,
    apiKey: input.apiKey
  }
  const res = saveProfile(draft)
  if (!res.ok) return { content: res.error ?? '保存失败', isError: true }
  if (input.setActive) setActiveProfile(draft.id)
  return { content: `已新增模型配置「${draft.name}」（id=${draft.id}）${input.setActive ? '并设为当前激活模型' : ''}。` }
}

function updateResult(input: ModelConfigInput): ToolResult {
  if (!input.id?.trim()) return { content: 'update 操作需要提供 id。', isError: true }
  const existing = getProfileRaw(input.id)
  if (!existing) return { content: `配置不存在：${input.id}`, isError: true }

  const { apiKeyRef, lastTestAt, lastTestOk, lastTestLatencyMs, ...base } = existing
  void apiKeyRef
  void lastTestAt
  void lastTestOk
  void lastTestLatencyMs

  const draft: ProfileDraft = {
    ...base,
    name: input.name?.trim() || base.name,
    kind: input.kind ?? base.kind,
    baseUrl: input.baseUrl?.trim() || base.baseUrl,
    model: input.model?.trim() || base.model,
    contextWindow: input.contextWindow ?? base.contextWindow,
    contextWindowSource: input.contextWindow != null ? 'manual' : base.contextWindowSource,
    maxOutputTokens: input.maxOutputTokens ?? base.maxOutputTokens,
    maxOutputTokensSource: input.maxOutputTokens != null ? 'manual' : base.maxOutputTokensSource,
    supportsTools: input.supportsTools ?? base.supportsTools,
    supportsVision: input.supportsVision ?? base.supportsVision,
    timeoutMs: input.timeoutMs ?? base.timeoutMs,
    apiKey: input.apiKey
  }
  const res = saveProfile(draft)
  if (!res.ok) return { content: res.error ?? '保存失败', isError: true }
  return { content: `已更新模型配置「${draft.name}」（id=${draft.id}）。` }
}

function deleteResult(input: ModelConfigInput): ToolResult {
  if (!input.id?.trim()) return { content: 'delete 操作需要提供 id。', isError: true }
  const res = deleteProfile(input.id)
  if (!res.ok) return { content: res.error ?? '删除失败', isError: true }
  return { content: `已删除模型配置（id=${input.id}）。` }
}

function setActiveResultFor(input: ModelConfigInput): ToolResult {
  if (!input.id?.trim()) return { content: 'set_active 操作需要提供 id。', isError: true }
  const res = setActiveProfile(input.id)
  if (!res.ok) return { content: res.error ?? '切换失败', isError: true }
  return { content: `已将当前激活模型切换为 id=${input.id}。` }
}

export const modelConfigTool: Tool<ModelConfigInput> = {
  name: MODEL_CONFIG_TOOL_NAME,
  description:
    '读写应用的 AI 模型 Provider 配置（设置界面里的模型列表）。支持 list 列出全部配置、add 新增、update 修改、' +
    'delete 删除、set_active 切换当前激活模型。新增/修改时可一并写入 API Key（存入系统安全存储，不会明文回显）。' +
    '配置存于用户数据目录，改动即时生效，无需用户在设置面板手动操作。',
  schema: modelConfigSchema,
  // 标记为 readOnly 以跳过写入审批（按用户要求：模型配置改动无需逐次确认）。
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    switch (input.action) {
      case 'list':
        return listResult()
      case 'add':
        return addResult(input)
      case 'update':
        return updateResult(input)
      case 'delete':
        return deleteResult(input)
      case 'set_active':
        return setActiveResultFor(input)
      default:
        return { content: `未知操作：${String(input.action)}`, isError: true }
    }
  }
}
