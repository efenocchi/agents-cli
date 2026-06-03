---
name: artist
description: >-
  Generate on-brand visual assets for the agents-cli web property — OG share
  covers, hero banners, blog headers — strictly conforming to BRAND.md,
  DESIGN.md, and ANTI_TELLS.md in the agent-cli-web repo. The default
  pipeline is **deterministic SVG → PNG** (rsvg-convert), not AI image
  generation, because the brand is type + flat solid + hairline rules and
  AI models garble it. AI generation is reserved for explicit one-off
  illustrations where the brand allows them.
  Triggers on: generate OG, design banner, make hero image, create cover
  for <page>, artist <page>, share card.
user-invocable: true
version: 0.2.0
author: muqsit
---

# artist

Generate brand-correct visual assets for any agents-cli surface without
re-explaining the design language every time. The brand is documented and
strict — this skill enforces it.

## Source of truth

**Always read these first, in order:**

1. `~/src/github.com/muqsitnawaz/agent-cli-web/BRAND.md` — voice, tokens, type
2. `~/src/github.com/muqsitnawaz/agent-cli-web/DESIGN.md` — components, spacing, radius
3. `~/src/github.com/muqsitnawaz/agent-cli-web/ANTI_TELLS.md` — the *forbidden* list

If any output of this skill matches a row in ANTI_TELLS.md, it is wrong by
definition. Rework before shipping.

---

## Arguments

`$ARGUMENTS` is free-form. Typical shapes:

- `og /install` — OG share card for the install page
- `og /docs/secrets` — OG card for the secrets doc
- `hero /pricing` — hero banner for a new page
- `card 1200x630 --slug=teams` — custom spec

If no surface is specified, default to `og /` (homepage).

---

## Brand DNA — non-negotiable

These tokens mirror `agent-cli-web/app/globals.css`. Do not invent new ones.

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0b0d0e` | Page background. Near-black with a faint green-cool tint. |
| `fg` | `#e6edf3` | Primary text. Off-white, GitHub-dark-coded. |
| `muted` | `#7d8590` | Secondary text, captions. |
| `accent` | `#39d353` | **Terminal-prompt green.** The literal git-status-clean color. One element per surface. |
| `border` | `#21262d` | Hairlines only. No drop shadows. |
| `panel` | `#111315` | Subtle panel surface (one shade above bg). |

**Font stack:**

- Body / display: **Inter** (sans), `var(--font-inter)`.
- Mono / wordmark / code / hex tokens: **JetBrains Mono** (mono).
- The mono is the brand-carrying face. When in doubt, use mono.

**Wordmark:** `agents-cli`, always lowercase, hyphenated, JetBrains Mono
weight 600. Color = `fg` on `bg`. Never on accent. The wordmark IS the
logo — there is no logotype glyph.

**Favicon / prompt glyph:** the `>` (or `>_`) terminal prompt in `accent`
on `bg`. That is the only mark beyond the wordmark.

---

## Forbidden patterns (ANTI_TELLS.md, condensed)

Every one of these is an automatic rework:

- Neon / RGB / synthwave palette
- Lime / mint accent (Linear neighborhood — explicitly out)
- Iridescent / holographic chrome
- Glassmorphism (`backdrop-filter: blur`, 8% white)
- Robot logos, chrome heads, glowing brains, chunky pixel letterforms
- Diagonal hero gradients (purple→pink etc.)
- `rounded-2xl`, soft drop shadows, conic spinners
- Fake macOS traffic-light chrome on code blocks
- AI-generated faces, hero illustrations of any kind
- Headlines ending in a period

---

## Workflow — OG cards (default)

OG cards are **typographic**. They must be generated as SVG and converted
deterministically to PNG. Never use Higgsfield / Midjourney / any image model
for OG cards — the model will garble the text and add anti-tells.

The canonical generator ships at:

```
agent-cli-web/scripts/gen-og.mjs
```

To add a new OG card:

1. Add an entry to the `COVERS` array in `gen-og.mjs`:

   ```js
   {
     slug: "<route-slug>",   // becomes /og/<slug>.png
     title: "<one or two word page title>",
     eyebrow: "agents-cli — <context>",
     body: "<one sentence sub>",
     cmd: "$ <one install or invocation command>"
   }
   ```

2. Run:

   ```bash
   cd agent-cli-web && bun run scripts/gen-og.mjs
   ```

3. Wire it into the page's `metadata`:

   ```ts
   export const metadata: Metadata = {
     openGraph: { images: [{ url: "/og/<slug>.png", width: 1200, height: 630 }] },
     twitter: { card: "summary_large_image", images: ["/og/<slug>.png"] }
   };
   ```

4. Rebuild + redeploy:

   ```bash
   bash scripts/build.sh
   agents secrets exec cloudflare.com -- wrangler pages deploy out \
     --project-name=agents-cli-web --branch=main --commit-dirty=true
   ```

## SVG card spec (mirrors gen-og.mjs)

A brand-correct OG looks like this — these are not suggestions, they are the spec:

- Canvas: 1200 × 630
- Background: solid `#0b0d0e` — no gradient
- Inner hairline frame: 24px inset, 1px solid `#21262d`
- Top-left: green `>_` prompt + mono `agents-cli` wordmark
- Eyebrow: 20px mono, `#7d8590`, light tracking
- Title: 120px mono, weight 700, `#e6edf3`
- Body: 26px Inter, `#7d8590`
- Command panel: full-width bar, `#000000` fill, 1px `#21262d` border,
  26px mono `#e6edf3`
- Bottom-right: small `agents-cli.sh` watermark in muted mono

If you find yourself adding a gradient, a glow, a card with shadow, a
sparkle icon, or a robot head — stop. Re-read ANTI_TELLS.md.

---

## When AI generation IS allowed

A narrow set of surfaces benefit from generated imagery:

- Blog post HEADER illustrations when the post is technical narrative and
  needs a single calm, on-brand cinematic scene (not a logo, not a wordmark).
- Empty-state placeholders (very rare).

In those cases, use Higgsfield via the Rush app's CDP socket, and the prompt
MUST include these brand anchors:

```
Background: solid near-black #0b0d0e with a faint green-cool tint.
Single accent only: terminal-prompt green #39d353 (do not introduce any other hue).
Aesthetic: docs site of a tool a senior engineer trusts — htmx.org, sqlite.org,
ripgrep README. Quiet, dense, monospace-leaning.

Forbidden: neon, holographic, glassmorphism, lime, mint, gradients,
robot heads, chrome letterforms, AI-style hero illustrations, sparkles.
```

The runner scripts ship at `runner/higgs-batch.js` and `runner/cdp-eval.js`
in this skill — they remain available for those narrow cases. The
`prompts/og-prompts.example.json` from v0.1 is preserved as a CAUTIONARY
EXAMPLE of what NOT to do (lime-accented, holographic, gradient-stacked) —
do not copy from it.

---

## Self-test

Before claiming an OG card works:

1. Render: `bun run scripts/gen-og.mjs`
2. Inspect: open `public/og/<slug>.png` and verify:
   - Solid `#0b0d0e` background, no gradient
   - `>_` is `#39d353`, everything else is `#e6edf3` / `#7d8590`
   - One readable font (JetBrains Mono / Inter), no garbled chars
   - Hairline border present
   - No glow, no shadow, no sparkles
3. Cross-check against `agent-cli-web/ANTI_TELLS.md` — every visible
   element should pass.

If any check fails, edit the SVG template in `gen-og.mjs` and re-render.
Do not ship.
