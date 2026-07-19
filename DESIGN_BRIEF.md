# DESIGN_BRIEF.md — EdgeBot dashboard (v2: faithful Mercury clone)

**Target:** `dashboard/index.html` (static, Vercel).
**Reference:** Mercury's live product dashboard — `demo.mercury.com/dashboard` (currently **dark mode**).
**Directive (v2):** a **faithful clone** of Mercury's dashboard — its colors, layout, typography, card system, and copy *voice* — applied to EdgeBot's own content. This overrides v1's identity-preservation. We keep EdgeBot's *name* (no impersonation) and use free fonts (Mercury's IO/Arcadia are proprietary); everything else mirrors Mercury.

## Palette — Mercury's live dark tokens (exact)
| token | hex | role |
|---|---|---|
| `--bg` | `#171721` | app canvas |
| `--surface` | `#1e1e2a` | cards |
| `--surface-2` | `#272735` | raised / pills / hover / active nav |
| `--line` | `#363644` | borders + dividers |
| `--ink` | `#ffffff` | primary text + big numbers |
| `--ink-2` | `#dddde5` | strong secondary |
| `--muted` | `#9d9da8` | secondary text |
| `--faint` | `#70707d` | tertiary / captions |
| `--accent` | `#5266eb` | primary button, active, chart line, links |
| `--accent-2` | `#465bd1` | accent hover |
| `--accent-l` | `#8da4f5` | link / focus light indigo |
| `--pos` | `#77c599` | positive / up |
| `--neg` | `#fc92b4` | negative / down |

## Type
- **Data / body / labels / nav / numbers → Roboto Mono** (Mercury's exact data font). tabular-nums.
- **Headings + big balance number → a neutral grotesque** (IO stand-in): Geist, fallback system-ui.
- Big number uses **superscript cents**: `$5,216,471`·`.18` — dominant integer, small raised decimals.
- Weights: headings 500–600, body 400. Line-height 1.5 body, 1.2 headings. ≤4 sizes per region.

## Layout — clone Mercury's home
- **Top bar** (dark, full width, ~56px): workspace mark + "EdgeBot" + a `Devnet` badge · a search-style field · right: a primary action + icon buttons + avatar dot.
- **Left sidebar** (~228px, dark): primary nav (Overview / Position / Blotter / Verify / The edge / Risk), active item = `--surface-2` filled row with indigo icon; a **Bookmarks**-style section below (Program ↗, Source, Dossier) with the value line under each.
- **Main**: 
  - Header line "Welcome back" + a plain subtitle; then an **action-pill row** (Verify · Explorer · Backtest · Dossier — first filled indigo).
  - **Balance card** (the hero): label "Realized P&L" + a verified check, the big **+100`.00` USDC** number, a "Last run" control, up/down deltas (↗ collected / ↘ staked), and the **area chart** (market YES → fair line) styled exactly like Mercury's balance chart (thin indigo line, soft indigo→transparent fill, faint x labels).
  - Beside it a **Position card** (Mercury "Accounts" analog): rows for Market, YES pool, NO pool, Mint, each with a mono value and a small avatar/'+N'.
  - A row of **small metric cards** (Mercury "Credit Card"/"Bill Pay" analog): Backtest (Brier + bar), Verify (6/6 + progress), Kill-switch (armed), Kelly (¼).
  - **Transactions list** (Mercury "Transactions" analog) = the autonomous blotter: rows of round · action · edge · amount, with a proof-settle footer row.
- Card radius **12px**, 1px `--line` borders, generous 20–24px padding, 4px grid, 20px gaps.

## Copy voice (match Mercury's tone, EdgeBot's words)
Plain, calm, sentence-case. Product-noun labels ("Realized P&L", "Last run", "Autonomous bets", "Position", "Verify"). Short. Human. Never salesy. No verbatim Mercury sentences — EdgeBot's content is its own (a trading agent, not a bank).

## Motion / craft
Mercury's `0.16s ease-out` color transitions on interactive elements; accessible focus ring (`0 0 0 1px bg, 0 0 0 3px accent-l`); subtle row hover (`--surface-2` at low alpha). Content visible by default; no reveal that gates visibility. `prefers-reduced-motion` respected.

## Content — real
All numbers from `dashboard/last-run.json`; quant from `quant-study.mjs`; verify = the 6-check `npm run judge:verify`. Market on program `AfvTru…DbD8`.

## Done
Reads as a Mercury dashboard at a glance (dark, indigo, Roboto Mono, card grid, superscript-cents balance). Desktop 1440 flawless; responsive. Contrast ≥4.5:1. No console errors.
