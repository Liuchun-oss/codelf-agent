// 内置技能简介的中文翻译表（方案 D：离线、零成本）。
// key 为技能名的小写形式；缺失的技能会回退展示英文原文。
// git 导入的第三方技能不在此表内，仍显示原始简介。

export const SKILL_DESCRIPTION_ZH: Record<string, string> = {
  'find-skills':
    '当用户在寻找某项功能（如「我该怎么做 X」「找个能做 X 的技能」「有没有能……的技能」）或希望扩展能力时，帮助发现并安装可用的 agent 技能。',
  'brainstorming':
    '在任何创意性工作（创建功能、构建组件、添加功能或修改行为）之前必须使用。在实现之前探索用户意图、需求和设计。',
  'caveman':
    '超压缩沟通模式。通过去掉冗余词、冠词和客套话，将 token 使用减少约 75%，同时保持技术准确性。当用户说「原始人模式」「少点 token」「简洁点」或调用 /caveman 时使用。',
  'dispatching-parallel-agents':
    '当面对 2 个或更多可以独立处理、无需共享状态或顺序依赖的任务时使用。',
  'executing-plans':
    '当你有一个需要在独立会话中执行并带有审查检查点的书面实施计划时使用。',
  'finishing-a-development-branch':
    '当实现完成、所有测试通过，需要决定如何集成工作时使用 - 通过呈现结构化选项（合并、PR 或清理）来指导开发工作的完成。',
  'frontend-design':
    '创建独特的、生产级前端界面，具有高设计质量。当用户要求构建 Web 组件、页面、工件、海报或应用程序时使用（例如网站、落地页、仪表盘、React 组件、HTML/CSS 布局，或美化任何 Web UI）。',
  'grill-me':
    '对计划或设计进行无情的质询采访，直到达成共识，解决决策树的每个分支。当用户想要压力测试计划、被质询设计或提到「质询我」时使用。',
  'grill-with-docs':
    '质询会话，根据现有领域模型挑战你的计划，明确术语，并在决策明确时内联更新文档（CONTEXT.md、ADR）。当用户想要根据项目语言和已记录的决策压力测试计划时使用。',
  'receiving-code-review':
    '当收到代码审查反馈、在实施建议之前使用，特别是当反馈看起来不清楚或技术上有疑问时 - 需要技术严谨性和验证，而不是表演性同意或盲目实施。',
  'requesting-code-review':
    '当完成任务、实现主要功能或在合并前使用，以验证工作是否符合要求。',
  'subagent-driven-development':
    '当在当前会话中执行具有独立任务的实施计划时使用。',
  'systematic-debugging':
    '遇到任何 bug、测试失败或意外行为时，在提出修复之前使用。',
  'test-driven-development':
    '实现任何功能或 bug 修复时，在编写实现代码之前使用。',
  'using-git-worktrees':
    '当开始需要与当前工作区隔离的功能工作或在执行实施计划之前使用 - 通过原生工具或 git worktree 后备确保存在隔离的工作区。',
  'using-superpowers':
    '在开始任何对话时使用 - 建立如何查找和使用技能，在任何响应（包括澄清问题）之前要求调用 Skill 工具。',
  'verification-before-completion':
    '当即将声称工作已完成、已修复或通过测试，在提交或创建 PR 之前使用 - 要求运行验证命令并在做出任何成功声明之前确认输出；始终先有证据再断言。',
  'writing-plans':
    '当你有多步任务的规范或需求时，在接触代码之前使用。',
  'writing-skills':
    '创建新技能、编辑现有技能或在部署前验证技能是否正常工作时使用。',
  'zoom-out':
    '告诉 agent 放大视角，提供更广泛的上下文或更高层次的视角。当你不熟悉某个代码部分或需要了解它如何融入更大的图景时使用。'
}

export function localizeSkillDescription(name: string, original: string): string {
  return SKILL_DESCRIPTION_ZH[name.trim().toLowerCase()] ?? original
}
