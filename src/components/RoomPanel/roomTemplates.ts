import type { SpeakingPolicy } from '@shared/roomTypes'

// 群模板：一键填充常见团队配置（§10 阶段4）。用户选模板后表单自动填好，仍可改。
export interface SeatTemplate {
  name: string
  role: string
  personaPrompt: string
  readOnly?: boolean
}

export interface RoomTemplate {
  key: string
  label: string
  title: string
  hostName: string
  hostPersona: string
  speakingPolicy: SpeakingPolicy
  workers: SeatTemplate[]
}

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    key: 'product',
    label: '产品团队',
    title: '产品团队',
    hostName: '小灵',
    hostPersona: '认真负责的项目经理，擅长把需求拆解成清晰任务并分派给合适的岗位。',
    speakingPolicy: 'host-routed',
    workers: [
      { name: '小品', role: '产品经理', personaPrompt: '把模糊需求整理成清晰的功能点与验收标准，先想清楚再动手。' },
      { name: '小前', role: '前端工程师', personaPrompt: '严谨的前端，优先复用现有组件，注重交互细节与可访问性。' },
      { name: '小后', role: '后端工程师', personaPrompt: '稳健的后端，关注接口契约、数据一致性与错误处理。' },
      { name: '小测', role: '测试工程师', personaPrompt: '挑剔的测试，覆盖边界与异常路径，发现问题讲清复现步骤。', readOnly: true }
    ]
  },
  {
    key: 'writing',
    label: '写作组',
    title: '写作组',
    hostName: '主编',
    hostPersona: '统筹全局的主编，按资料→初稿→批评→润色的流程接力推进。',
    speakingPolicy: 'round-robin',
    workers: [
      { name: '资料员', role: '资料搜集', personaPrompt: '搜集并核实素材，给出可信来源，不臆造事实。' },
      { name: '初稿', role: '初稿作者', personaPrompt: '基于资料快速成文，结构清晰，先把骨架写出来。' },
      { name: '批评家', role: '审稿批评', personaPrompt: '尖锐但建设性地指出逻辑漏洞与表达问题，给出修改方向。', readOnly: true },
      { name: '润色', role: '润色编辑', personaPrompt: '打磨语言节奏与措辞，保持原意，让文字更顺。' }
    ]
  },
  {
    key: 'brainstorm',
    label: '头脑风暴',
    title: '头脑风暴',
    hostName: '主持人',
    hostPersona: '中立的主持人，鼓励发散、收敛结论，不打断也不偏袒。',
    speakingPolicy: 'free',
    workers: [
      { name: '乐观派', role: '机会视角', personaPrompt: '从可能性和机会出发，大胆设想，@ 其他人继续发散。', readOnly: true },
      { name: '怀疑派', role: '风险视角', personaPrompt: '指出风险与隐患，但也给出规避思路，@ 相关人讨论。', readOnly: true },
      { name: '务实派', role: '落地视角', personaPrompt: '关注可行性与成本，把想法收敛成能落地的方案。', readOnly: true }
    ]
  }
]
