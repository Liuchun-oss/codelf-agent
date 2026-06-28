---
name: get-context
description: "Mandatory design-brief gate for Product Design build and design workflows. Use before ideation, prototyping, image-to-code builds, redesigns, or product UI work to clarify missing product, visual, and interactivity context or play back the supplied brief before proceeding."
allowed_tools: [AskUserQuestion]
---

# Get Context

Gather only the context needed for the next design action. This skill resolves or confirms the design brief; it does not implement UI or create durable design artifacts.

Run this skill at the start of Product Design requests that ask to design, build, prototype, clone, redesign, extend, or generate product UI directions.

Use question mode when any of the following are unclear:

- what product, site, feature, workflow, component, or screen is being designed
- what visual source should determine how it looks
- what concrete preferences or avoidances should shape visual exploration when no source exists
- what level of interactivity the user expects

In question mode, ask via the `AskUserQuestion` tool (structured multiple-choice), not free-form prose. Bundle the unclear items into one `AskUserQuestion` call with multiple questions so the user can answer in one pass. The UI always offers an Other/custom-text choice, so the user can still type a free answer. Only fall back to plain-text questions if the `AskUserQuestion` tool is unavailable.

Use playback mode when the user already provided the needed details. In playback mode, do not re-ask answered questions; play back the brief in a pithy format and name the next workflow.

Hard boundary: do not implement UI, scaffold a prototype, start a server, or create files while context is still missing.

## Critical Overrides

- Refer to the Plugin router [$index](../index/SKILL.md) before proceeding.
- Follow [$critical-overrides](../../references/critical-overrides.md).

## User Context

Before starting, load [$user-context](../user-context/SKILL.md) and run its preflight script when local shell access is available.

Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets as grounding material when relevant.

Do not inspect every saved reference. Inspect only what the current task needs.

## Get Context Script

The following three areas should be answered by the user. Adapt the questions based on what the user has provided so far in the conversation. If some or all fields are already known, skip the questions and summarize the design brief in your own words.

Ask the unclear ones in a single `AskUserQuestion` call (one entry per unclear area). Each question needs 2-4 concise options plus a short `header` chip; the UI auto-adds an Other/custom choice for free-form answers.

The three areas to resolve are:

1. Goal — What do you want the thing to do? (its core purpose / key actions)
2. Visual source — What existing product, design system, Figma file, screenshot, URL, or image should it match? If none, what look/style are you going for? Mention existing design systems already in user-context if they exist.
3. Interactivity level — one of:
   - Full interactivity: all controls and states are completely functional and implemented.
   - Static: controls and states are minimally interactive, preferring speed.

Example `AskUserQuestion` call (adapt options to the actual request):

```json
{
  "questions": [
    {
      "header": "目标",
      "question": "这个页面/产品主要要做什么？",
      "options": [
        { "label": "品牌展示官网", "description": "突出品牌形象与卖点的展示型页面" },
        { "label": "可下单/转化", "description": "包含下单、预约或留资等转化动作" },
        { "label": "信息/内容站", "description": "以内容浏览、列表与详情为主" }
      ]
    },
    {
      "header": "视觉风格",
      "question": "有没有要参照的视觉来源？没有的话想要什么风格？",
      "options": [
        { "label": "高级/精致", "description": "克制留白、精致排版与动效，高端质感" },
        { "label": "大胆/个性", "description": "强烈主色、夸张排版，记忆点突出" },
        { "label": "参照某个网址/截图", "description": "我会提供 URL 或设计稿来匹配" }
      ]
    },
    {
      "header": "交互度",
      "question": "需要多少交互？",
      "options": [
        { "label": "完整交互", "description": "控件、状态、表单等都真实可用" },
        { "label": "偏静态", "description": "以视觉为主，控件最小交互，出得更快" }
      ]
    }
  ]
}
```

## Final message

1. Before proceeding to `$ideate`, `$prototype`, `$url-to-code`, or `$image-to-code`, confirm the design brief by explaining it back to the user in a pithy format as a `final` message.

2. Proceed only after the user confirms the design brief, unless the current thread already contains confirmation of that exact brief. If the user provides feedback, continue to refine the design brief with them.

3. After the user confirms the design brief, send one short expectation-setting note before starting an involved app, prototype, clone, redesign, or build. Example confirmation message with expectations setting:

```text
Lovely, brief locked. This kind of build usually takes about 10-15 minutes, and ambitious ones can take longer. Good moment to grab coffee or tend to something else; I'll keep moving and bring the prototype back when it is ready.
```

Do not send this note for tiny static changes, quick audits, simple research, setup-only, or share-only requests.

Done means the user has confirmed the design brief.
