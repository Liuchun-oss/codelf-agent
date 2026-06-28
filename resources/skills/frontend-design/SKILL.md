---
id: frontend-design
name: Frontend Design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
when_to_use: 用户要求构建或美化前端界面，例如网站、落地页、仪表盘、React/Vue 组件、HTML/CSS 布局、海报或任何 Web UI 的样式设计
context: inline
version: "1.0"
source_repo: https://github.com/anthropics/skills (frontend-design)
license: See LICENSE.txt in this skill directory
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. 严禁千篇一律的紫色渐变（尤其是 purple/violet → blue 渐变配白底），这是最典型的「AI 味」配色，必须主动规避。每次生成都要换不同的色系与主色调。
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise. 追求**有高级感的交互与动效**：流畅的缓动曲线（cubic-bezier 自定义而非默认 ease）、视差/滚动联动、磁吸按钮、平滑的状态过渡、有物理感的入场动画。动效要克制而精致，服务于氛围，而非堆砌花哨效果。
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

## 硬性约束（Hard Constraints）

以下规则必须严格遵守，优先级高于个人发挥：

- **禁止滥用 emoji 表情**：不要大批量、装饰性地堆砌 emoji 小表情（如 ✨🚀🎉💡 等）。emoji 不能替代真正的图标系统或视觉设计；仅在确有语义、且数量克制时使用。
- **图像资源优先级**：当需要插图、图标、装饰图形时——
  - 若**图像生成工具可用**，优先用图像生成，但必须处理成 **PNG 且透明背景**（去除白底/纯色底，便于叠加到任意背景）。
  - 若图像生成工具**不可用**，则使用 **SVG**（矢量、可缩放、可内联控制样式与动效），不要用占位图或低质量位图。
- **禁止千篇一律的紫色渐变**：主动远离「紫色/品紫渐变 + 白底」这类最典型的 AI 默认审美（去 AI 味）。每次都要选择与场景契合、且彼此不同的配色方案。
- **追求高级感的互动与动态效果**：交互和动效要精致、有质感、有节奏，体现设计意图，而非生硬的默认过渡或浮夸堆砌。
- **不强制单 HTML 文件**：不必把所有代码塞进一个 HTML 文件。应**尽可能按职责分目录组织**，例如：
  - HTML/页面入口放在根目录或 `pages/`
  - CSS 样式统一放入 `css/` 或 `styles/`
  - JavaScript 放入 `js/` 或 `scripts/`
  - 图片、SVG、字体等静态资源放入 `assets/`（可再细分 `assets/images/`、`assets/icons/`、`assets/fonts/`）
  - 让目录结构清晰、可维护，静态资源各归其位。

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: you are capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.