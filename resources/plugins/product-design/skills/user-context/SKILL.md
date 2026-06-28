---
name: user-context
description: Load or manage Product Design's saved user context. Use when the user asks to set up Product Design, get started, onboard, save product or design sources, see what Product Design remembers, update saved context, or remember Product Design preferences. Examples include product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, and general product/design notes.
---

> [!NOTE] Codelf 适配说明
> 本插件原为 Codelf 编写，以下内容在 Codelf 下需调整：
> 本 skill 原文引用了 Codelf 专属的 in-app browser 启动流程（CODELF_HOME / node_repl / browser-client / openai-bundled）。在 Codelf 中请忽略那段 Node REPL bootstrap 代码，改为直接调用 `OpenInAppBrowser` 工具并传入本地 URL（如 http://127.0.0.1:PORT），页面会在 Codelf 内置浏览器标签中打开给用户，且支持 localhost。若只是需要 agent 读取/自动操作页面，则改用 Browser*（Playwright）工具组。
> 本 skill 原文依赖 Codelf 内置图像生成（imagegen）与 $CODELF_HOME/generated_images 目录。Codelf **已内置图像生成工具**：凡是“用 imagegen 生成图片”的步骤，一律改为调用延迟工具 `GenerateImage`（文生图）或 `EditImage`（图生图/改图）。调用前先用 `SearchExtraTools` 以 select:GenerateImage（或 select:EditImage）发现该工具，再用 `ExecuteExtraTool` 执行。工具会返回 codelf-artifact:// 形式的本地图片路径，直接把该路径用于后续插入/保存步骤；不要再去 $CODELF_HOME/generated_images 找文件，也**不要跳过生成步骤或假称已生成**。


# User Context

User Context stores the product and design references a designer uses often, so future Product Design work starts from the right sources.

Use this skill when the user asks to:

- set up Product Design
- get started with Product Design
- onboard with Product Design
- save product or design sources
- see what Product Design remembers
- update saved product or design context
- remember a Product Design preference
- setup my plugin

## Critical Overrides

- Refer to the Plugin router [$index](../index/SKILL.md) before proceeding.
- Follow [$critical-overrides](../../references/critical-overrides.md).

## Saved User Context

If `user-context.md` exists, use it by default.

Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets to ground Product Design work.

Ideation, prototypes, audits, clones, and critiques should match the saved product context unless the user asks for something different.

When a workflow needs visual grounding, attach or include relevant saved screenshots, reference images, tokens, design language, and component references in ImageGen, ideation, prototype, audit, and critique work.

## State File

Saved context lives here:

```text
$CODELF_HOME/state/plugins/product-design/user-context.md
```

Saved screenshots and reference images live next to it:

```text
$CODELF_HOME/state/plugins/product-design/assets/
```

If the file does not exist, continue normally unless the user asks to set up Product Design, save context, or the current task is blocked by missing product/design context.

## Preflight

When any Product Design workflow needs saved context, run:

```bash
python3 scripts/user_context_preflight.py
```

Use the returned saved entries as the starting context for the task.

If the script reports that no saved context exists, continue from the current user prompt unless setup context is required.

Do not browse, open, or inspect every saved reference during preflight. Inspect only the saved references needed for the current task.

## Setup

Use [references/onboarding.md](references/onboarding.md) when the user asks to set up Product Design, asks what Product Design can remember, asks what Product Design knows about their product, or provides product/design references to save.

For setup-only requests, explain what Product Design can remember and ask for useful sources.

Adjust the context-gathering request to match the user's request. First-time setup differs from updating existing context.

Do not inspect the workspace, install dependencies, scaffold a prototype, generate images, run audits, or start implementation during setup.

After the user provides references to save, run:

```bash
python3 scripts/init_user_context.py
```

Then add the references to the created `user-context.md`.

## Save

Save useful, durable Product Design context:

- Product URLs
- Figma files
- Screenshots and reference images
- Codebase paths
- Storybook and component docs
- Design tokens and theme sources
- Brand, logo, icon, illustration, image, and asset sources
- Preferred browser, capture tools, and share targets
- Team conventions that make future Product Design work more accurate

When the user provides screenshots or reference images to save, copy them into `assets/` next to `user-context.md` and link them from the saved entry.

Give each saved image a clear, descriptive filename that says what the image shows. Use names future Product Design runs can understand without opening the file.

Good image names:

```text
assets/chatgpt-settings-modal-dark-mode.png
assets/payment-sheet-mobile-error-state.png
assets/product-dashboard-sidebar-navigation.png
assets/storybook-primary-button-states.png
assets/brand-logo-lockup-purple-gradient.png
assets/onboarding-flow-welcome-step.png
assets/checkout-confirmation-screen.png
assets/account-menu-open-state.png
```

Do not save secrets, credentials, API keys, private tokens, copied customer data, or anything that should not persist.

Use this structure:

```md
# {Category}

- Description: {what this category is and when future Product Design runs should use it}

## Saved Links And Context

{Saved reference or fact}
- Date Added: YYYY-MM-DD.
- File: assets/{clear-descriptive-name}.png
- Useful Context: {what this reference represents}
- Future Use: {how future Product Design work should use it}
```

Include `File:` only when the saved entry has a local image file.

When a category has no saved references yet, use exactly:

```md
status: not provided
```

Keep saved context curated. Prefer a few high-value references over a dump of every possible URL or file.

## Read

- Do not treat `status: not provided` as a fact.
- Read through `scripts/user_context_preflight.py` when local shell access is available.
- Use saved context as default grounding, then inspect only what the current task needs.
