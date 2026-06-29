// 内置技能简介的中文翻译表（方案 D：离线、零成本）。
// key 为技能名的小写形式；缺失的技能会回退展示英文原文。
// git 导入的第三方技能不在此表内，仍显示原始简介。

export const SKILL_DESCRIPTION_ZH: Record<string, string> = {
  'find-skills':
    '当用户在寻找某项功能（如「我该怎么做 X」「找个能做 X 的技能」「有没有能……的技能」）或希望扩展能力时，帮助发现并安装可用的 agent 技能。',
  'caveman':
    '超压缩沟通模式。通过去掉冗余词、冠词和客套话，将 token 使用减少约 75%，同时保持技术准确性。当用户说「原始人模式」「少点 token」「简洁点」或调用 /caveman 时使用。',
  'dispatching-parallel-agents':
    '当面对 2 个或更多可以独立处理、无需共享状态或顺序依赖的任务时使用。',
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
  'systematic-debugging':
    '遇到任何 bug、测试失败或意外行为时，在提出修复之前使用。',
  'test-driven-development':
    '实现任何功能或 bug 修复时，在编写实现代码之前使用。',
  'using-git-worktrees':
    '当开始需要与当前工作区隔离的功能工作或在执行实施计划之前使用 - 通过原生工具或 git worktree 后备确保存在隔离的工作区。',
  'verification-before-completion':
    '当即将声称工作已完成、已修复或通过测试，在提交或创建 PR 之前使用 - 要求运行验证命令并在做出任何成功声明之前确认输出；始终先有证据再断言。',
  'writing-skills':
    '创建新技能、编辑现有技能或在部署前验证技能是否正常工作时使用。',
  'zoom-out':
    '告诉 agent 放大视角，提供更广泛的上下文或更高层次的视角。当你不熟悉某个代码部分或需要了解它如何融入更大的图景时使用。',
  'docx':
    '当用户需要创建、读取、编辑或处理 Word 文档（.docx 文件）时使用。触发词包括「Word 文档」「word doc」「.docx」，或要求生成带目录、标题、页码、信头等格式的专业文档。也用于从 .docx 提取或重组内容、插入或替换文档中的图片、在 Word 文件中查找替换、处理修订与批注，或把内容整理成精美的 Word 文档。当用户要「报告」「备忘录」「信函」「模板」等 Word/.docx 交付物时使用。不要用于 PDF、表格、Google Docs 或与文档生成无关的编程任务。',
  'pptx':
    '只要涉及 .pptx 文件（作为输入、输出或两者）就使用本技能。包括：创建幻灯片、路演稿或演示文稿；读取、解析或从任意 .pptx 提取文本（即便提取内容用在别处，如邮件或摘要）；编辑、修改或更新现有演示文稿；合并或拆分幻灯片文件；处理模板、版式、演讲者备注或批注。当用户提到「幻灯片」「PPT」「演示文稿」「deck」或引用 .pptx 文件名时触发，无论后续打算如何使用。',
  'pdf-extraction':
    '使用 pdfplumber 从 PDF 中提取文本、表格和元数据。',
  'document-converter':
    '当用户需要在不同格式间转换文档（Office 转 PDF、PDF 转图片、图片转 PDF）、执行 PDF 操作（合并、拆分、旋转、加密、解密），或对扫描件做 OCR 时使用。基于本地免费工具（LibreOffice、ghostscript、pdftk、tesseract、imagemagick），无需 API key。当用户说「转换这个文档」「导出为 PDF」「合并 PDF」「拆分 PDF」「旋转 PDF」「对这张扫描件做 OCR」「PPTX 转 PDF」「DOCX 转 PDF」或任何文档格式转换请求时触发。'
}

// 内置插件简介的中文翻译表。key 为插件名小写；缺失回退英文原文。
export const PLUGIN_DESCRIPTION_ZH: Record<string, string> = {
  'product-design':
    'Product Design 插件用于把早期想法变成团队可评审的原型。它先确认设计简报，再帮助团队探索产品方向、审计用户流程、从线上 URL 克隆原型，并让静态截图变得可交互。'
}

export function localizeSkillDescription(name: string, original: string): string {
  return SKILL_DESCRIPTION_ZH[name.trim().toLowerCase()] ?? original
}

export function localizePluginDescription(name: string, original: string | undefined): string | undefined {
  return PLUGIN_DESCRIPTION_ZH[name.trim().toLowerCase()] ?? original
}
