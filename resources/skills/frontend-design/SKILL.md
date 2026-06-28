---
id: frontend-design
name: Frontend Design
description: Create distinctive, premium, production-grade frontend interfaces with high design quality while actively avoiding AI-slop tells. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (websites, landing pages, dashboards, React components, HTML/CSS layouts) or to style/beautify any web UI, especially when they want it to feel high-end, polished, visually striking, or interactive. Sets a design read + three dials (variance/motion/density), enforces strict anti-AI-tell bans (em-dash ban, AI-purple ban, beige+brass premium-palette ban, three-equal-cards ban), and runs a pre-flight checklist before shipping.
when_to_use: The user asks to build or beautify a frontend interface (website, landing page, dashboard, React/Vue component, HTML/CSS layout, poster, or any web UI), or mentions wanting it to feel high-end, polished, visually striking, animated, interactive, or explicitly "not AI-looking".
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
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: you are capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## Set the Direction: Read the Brief, Then Set Three Dials

> Most AI design output looks "off" because the model skips the context and jumps straight to a default aesthetic. Do two things before writing any code.

**Step 1 - One-line Design Read**: State in one sentence how you interpret the brief, e.g. "Reading this as: a B2B SaaS landing page for technical buyers, Linear-style minimalism, leaning toward Tailwind + Geist + restrained motion." When context is sufficient, **do not ask** - just declare the read and proceed. Only ask **one** question when the direction genuinely diverges.

**Step 2 - Set three dials (1-10)**. Every layout, motion, and density decision below is gated by these:

- **DESIGN_VARIANCE** (1 = perfect symmetry, 10 = artsy chaos): default 8.
- **MOTION_INTENSITY** (1 = static, 10 = cinematic / physics): default 6.
- **VISUAL_DENSITY** (1 = art-gallery airy, 10 = cockpit dense): default 4.

Adjust the baseline by context: minimal / Linear-style ≈ 5-6 / 3-4 / 2-3; premium consumer / Apple-y ≈ 7-8 / 5-7 / 3-4; creative agency / Awwwards ≈ 9-10 / 8-10 / 3-4; trust-first / public-sector / accessibility-critical ≈ 3-4 / 2-3 / 4-5.

**Anti-default discipline**: never reach blindly for these LLM defaults - AI-purple gradients, a centered hero over a dark mesh, three equal feature cards, glassmorphism on everything, infinite-loop micro-animations everywhere, Inter + slate-900. Deliberately reach past them based on the Design Read.

## Workflow

Core belief: **ship a stunning result on the first pass**. Do not wait for the user to say "make it prettier" before putting in the effort. Treat the guidelines below as the default standard, not bonus points.

1. **Quick clarification (one round max, non-blocking)**: ask only when you cannot set the direction, and ask everything at once. Prefer inferring and offering defaults the user can veto over repeated questioning. Key dimensions: product type, aesthetic direction, brand constraints (primary color / fonts / logo), tech stack. When the user just says "build me an X", proceed with the most reasonable defaults and state your assumptions on delivery.
2. **Lock the direction**: before coding, pin down one globally consistent foundation - a single core visual hook (what grabs attention), the palette (primary / secondary / neutral scale / accent + dark mode), font pairing, and a spacing / radius rhythm scale.
3. **Build**: produce production-grade, runnable, interactive real code, not a static mockup. Get it right in one pass.
4. **Verify**: run it or screenshot-audit it, and check against the pre-flight checklist below item by item. If a browser tool is available, open a local preview and compare desktop vs mobile.

## Motion & Interaction (the soul of an "interactive UI")

Motion makes a page feel alive, but it must serve the experience, not upstage it.

- **Entrance animations**: content fades / rises in on scroll (IntersectionObserver or Motion's `whileInView`), with subtle staggered timing.
- **Micro-interactions**: buttons / cards / links all give hover/active/focus feedback (scale, translate, shadow, color). Transitions 150-400ms, easing via a custom `cubic-bezier`, not linear.
- **Pointer response**: optional cursor-following glow, 3D tilt (`rotateX/Y` tracking the pointer), magnetic buttons and other premium touches, but keep the count small.
- **Scroll narrative**: long pages use parallax, sticky nav, progress indicators, and number count-ups to guide the eye.
- **State transitions**: route changes, expand/collapse, and modal enter/exit all get transitions - use `AnimatePresence` for enter/exit, never hard cuts.
- **Performance floor**: animate only `transform` and `opacity` (GPU-accelerated); avoid triggering layout.
- **Restraint**: don't move too many elements on screen at once. Motion is seasoning, not the main course.

## Accessibility (high-end does not mean sacrificing usability)

- Text-to-background contrast passes (body ≥ 4.5:1, large text ≥ 3:1); check text over gradients / glass especially.
- Every interactive element has a clear `:focus-visible` style and is keyboard-operable; images have `alt`, icon buttons have `aria-label`, and semantic tags are correct.
- Motion honors `prefers-reduced-motion` with a degraded fallback; dark mode adapts to `prefers-color-scheme`.

## No AI Slop (hard bans - redo on sight)

> These are the patterns most likely to expose "AI fingerprints" in production tests. Unless the brief explicitly calls for one, treat them all as hard bans.

**Typography & fonts**

- ❌ Defaulting to `Inter`. Prefer `Geist`, `Outfit`, `Cabinet Grotesk`, `Satoshi`, or a brand-appropriate font. Use Inter only when the user explicitly wants a neutral / standard / Linear feel, or for public-sector / accessibility sites.
- ❌ Reaching for serif as the default "creative / premium" choice. "Feels creative" is not a reason to use serif - it is the most common AI tell. Allowed only when the brand names a serif, or it is genuinely editorial / publication / luxury / vintage. Specifically ban `Fraunces` and `Instrument Serif` as defaults.
- ❌ Oversized H1s that just shout. Control hierarchy with weight + color, not raw scale.
- ❌ Injecting a second font family to emphasize a word in a headline (a random serif word inside a sans headline). To emphasize, use **italic or bold of the same font**.

**Color**

- ❌ AI purple/blue outer glows, random neon gradients. Use neutral bases (Zinc/Slate/Stone) + a single high-contrast accent (emerald, electric blue, deep rose, burnt orange, etc.), lock that one accent across the whole page, max 1 accent, saturation < 80% by default.
- ❌ Pure black `#000000` / pure white `#ffffff` in large fields. Use off-black (zinc-950 / warm charcoal) and off-white; pure values kill depth.
- ❌ **The "beige + brass" default luxury palette for premium-consumer brands (second-most-common AI tell)**: for cookware / wellness / artisan / luxury / heritage-craft briefs, AI defaults to "warm cream/paper background + brass/clay/oxblood/ochre accent + espresso near-black text". Ban this as the default reach. Alternatives (rotate, don't reuse twice in a row): cold silver-grey + chrome + smoke; deep green + bone + amber; true black + warm tan hard contrast; cobalt + cream; terracotta + slate; muted olive + brick red; pure monochrome + one saturated pop. Use the beige set only when the brand names those colors.

**Layout & composition**

- ❌ Three equal feature cards in a row. Use 2-column zigzag, asymmetric grid, scroll-pinned, or horizontal-scroll alternatives.
- ❌ A centered hero/H1 when `DESIGN_VARIANCE > 4`. Force split-screen, left-text/right-asset, asymmetric whitespace, or scroll-pinned structures (editorial / manifesto launches excepted).
- ❌ The same layout family appearing more than once on a page. With 8 sections, use at least 4 different layout families.
- ❌ 3+ consecutive "left-image/right-text" zigzag sections. Max 2 in a row; the 3rd must switch families.
- ❌ An `uppercase tracking` eyebrow label above every section heading. Max 1 eyebrow per 3 sections - drop the rest, the headline alone is enough.
- ❌ Section-number eyebrows (`00 / INDEX`, `001 · Capabilities`, `06 · how it works`), `01 / 4` pagination on images, `Scroll · 001` scroll cues.

**Decorative tells**

- ❌ The middle dot `·` as an all-purpose separator (max 1 per line); a colored status dot before every list/nav/badge (unless it conveys real semantic state).
- ❌ A decorative text strip at the hero bottom (`BRAND. MOTION. SPATIAL.`); vertical 90°-rotated text; purely decorative crosshair / grid hairlines.
- ❌ Locale/time/weather strips (`Lisbon 14:23 · 18°C`), scroll cues (`Scroll`, `↓ scroll`, `Scroll to explore`), version footers on marketing pages (`v1.4.2`, `Build 0048`).
- ❌ Label pills overlaid on images (`Plate · Brand`), fake photo captions (`Field study no. 12 · Ines Caetano`).
- ❌ Version badges in the hero (`V0.6`, `BETA`, `INVITE-ONLY`) unless the brief is about a launch/preview status.

**Content & copy (the "Jane Doe" effect)**

- ❌ Generic names (John Doe / Sarah Chan), generic avatars (egg / user icon), perfect round numbers (99.99%, 50%, 1234567). Use believable, locale-appropriate, slightly "messy" data.
- ❌ Startup-slop brand names (Acme / Nexus / SmartFlow / Cloudly); filler verbs (Elevate / Seamless / Unleash / Next-Gen / Revolutionize).
- ❌ Performative social-proof / labels like "Quietly in use at", "Field notes", "On our desks"; a small meta sentence padded under an eyebrow.
- ❌ **Mandatory copy self-audit before shipping**: re-read every visible string on the page (headlines / subheads / eyebrows / buttons / body / captions / alt / footer). Rewrite anything grammatically broken, with unclear referents, or that reads like AI trying to sound clever into a plain functional sentence. AI "clever copy" is worse than boring copy.

**Images & components**

- ❌ Building fake product screenshots / dashboards / terminals out of divs - the #1 AI tell. Use a real screenshot / generated image / real component preview, or nothing. The hero needs a real visual; "text + gradient blob" is not a hero.
- ❌ Hand-rolled decorative SVG icons. Use an icon library (Phosphor / HugeIcons / Radix / Tabler), standardize `strokeWidth` globally, one icon family per project.
- ❌ `border-t` + `border-b` on every row of a long list / spec table. For > 5 items switch components: grouping, card grid, tabs/accordion, horizontal-scroll pills, carousel.
- ❌ Logo walls as plain text wordmarks; use real SVG logos (Simple Icons / devicon) or generated letter monograms, and the logo wall holds logos only - no industry labels.

**Em-dash ban (the most-violated tell)**

- ❌ The em-dash `—` and the en-dash `–` as a separator are **completely banned** - there is no "a little is fine". They must not appear in headlines, eyebrows, pills, body, quotes, attribution, captions, buttons, or alt text. Use a period, comma, parentheses, colon, or line break. Date/number ranges use a plain hyphen `-`. A single `—` on the page fails the pre-flight check.

**CTAs & forms (accessibility hard rules)**

- ❌ Insufficient button text-to-background contrast (white-on-white, a transparent button with no border floating on the background). Every CTA passes WCAG AA (body 4.5:1, large text 3:1).
- ❌ CTA text wrapping at desktop (> 1 line). Keep primary CTAs to 3 words, or widen the button.
- ❌ Multiple CTAs with the same intent ("Get in touch" + "Let's talk" + "Contact us" all present). One label per intent, page-wide.
- ❌ Placeholder-as-label. The label always sits above the input.

## Where High-End Polish Comes From (consistency locks + hero discipline)

Refinement is not piling on elements; it is "restraint + global consistency + one or two memorable moments". Lock these before building and audit them before shipping:

- **Theme lock**: one theme for the whole page (light/dark/auto), sections do not invert. No warm-beige section dropped into a dark page.
- **Accent lock**: once chosen, the accent is identical page-wide - no blue CTA suddenly appearing in section 7.
- **Radius lock**: one corner-radius scale throughout (all-sharp / all 12-16px / all-pill for interactive). Round buttons in a square layout is a tell.
- **Shadows**: tint shadows to the background hue; no pure-black drop shadows on light backgrounds. Use cards only when elevation maps to real hierarchy, otherwise group with `border-t` / `divide-y` / whitespace.
- **Hero discipline**: the hero must fit the first viewport - headline ≤ 2 lines, subtext ≤ 20 words and ≤ 4 lines, CTA visible without scrolling; top padding ≤ `pt-24` at desktop; max 4 text elements in the hero (eyebrow or brand strip, headline, subtext, CTA), moving trust strips / pricing teasers / feature lists to dedicated sections below.
- **Viewport stability**: use `min-h-[100dvh]` for full height, never `h-screen` (iOS address bar jumps).
- **Real images**: even minimalist sites need 2-3 real images. Generate them if a tool is available; otherwise use `picsum.photos/seed/{descriptive}/{w}/{h}`; if neither is possible, leave clearly-labeled placeholder slots and tell the user.

## Pre-Flight Checklist (verify each before shipping - any miss means not done)

- [ ] One-line Design Read declared; the three dial values are explicit and reasoned from the brief, not silently using the baseline.
- [ ] **Zero em-dashes (`—`/`–`) page-wide**: headlines/eyebrows/pills/body/quotes/attribution/captions/buttons/alt all checked.
- [ ] Theme lock / accent lock / radius lock all consistent.
- [ ] Every CTA passes WCAG AA against its background and does not wrap at desktop; no duplicate-intent CTAs.
- [ ] Font is not the default Inter (unless a neutral feel was requested); if a serif is used, it is not Fraunces/Instrument Serif and has a brand reason.
- [ ] Premium-consumer briefs do not use the beige + brass + espresso AI-default luxury palette.
- [ ] Hero fits the first viewport (headline ≤ 2 lines, subtext ≤ 20 words, CTA visible), ≤ 4 text elements, top padding ≤ `pt-24`.
- [ ] Eyebrow count ≤ ⌈section count / 3⌉; no section-number eyebrows.
- [ ] At least 4 layout families across 8 sections; no 3 consecutive zigzags; no three equal feature cards.
- [ ] Logo wall sits below the hero and holds real SVG logos only (no industry labels, no plain text names).
- [ ] Copy self-audited: no broken grammar / AI-hallucinated phrases; names/brands/numbers are real and "messy", not Jane Doe / Acme / perfect round numbers.
- [ ] Real images (generated first, then picsum-seed, then placeholder slots); no div-based fake screenshots, no hand-rolled decorative SVGs, no text-only fake minimalism.
- [ ] No decorative tells: locale/time/weather strips, scroll cues, version footers, image-overlay pills, fake captions, hero decoration strips all removed.
- [ ] When `MOTION_INTENSITY > 4`, the page actually moves (hero entrance + scroll-reveal on key sections + CTA hover), not just claimed.
- [ ] Every animation is justifiable in one sentence (hierarchy / storytelling / feedback / state change), no motion-for-show; max 1 horizontal marquee page-wide.
- [ ] Motion uses only `transform`/`opacity`; `window.addEventListener('scroll')` is banned, use `useScroll`/ScrollTrigger/IntersectionObserver/CSS scroll-driven animations; `useEffect` animations have cleanup functions.
- [ ] Everything with `MOTION_INTENSITY > 3` is wrapped with a `prefers-reduced-motion` fallback.
- [ ] Dark-mode tokens defined and verified in both modes; high-variance layouts have explicit mobile collapse (`w-full`/`px-4`/`max-w-7xl mx-auto`).
- [ ] Empty / loading / error states present; icons only from allowed libraries (Phosphor/HugeIcons/Radix/Tabler).
- [ ] Core Web Vitals plausibly met (LCP < 2.5s, INP < 200ms, CLS < 0.1).

Remember: **ship a stunning result on the first pass** and treat these guidelines as the default, not bonus points. If a single box cannot be ticked, it is not done.
