# DESIGN_BRIEF.md — EdgeBot dashboard

**Target file:** `/Users/mac/edgebot-txline/dashboard/index.html` (static, self-contained, Vercel).
**Craft reference (quality bar only):** Mercury product dashboard — `demo.mercury.com/dashboard`, extracted to `design-ref/mercury/demo-design/`.
**What we take from Mercury:** spacing rhythm, 4px grid discipline, the dominant-number-with-superscript-cents treatment, mono-forward data voice, single-accent restraint, calm card density, the 0.16s micro-transition, the accessible double-ring focus.
**What we do NOT take (banned by the method):** its colors, its indigo, its light theme, its identity, its content. EdgeBot keeps its own dark teal/gold identity.

**The one structural decision:** EdgeBot's page today is a *marketing landing page about* a trading agent. Mercury is *the product*. So we convert EdgeBot into **the terminal itself** — app chrome, a live position cockpit, dashboard cards — and let the proof/quant narrative live *below* as dashboard panels, not marketing sections.

---

## 1. Theme — decided, not defaulted

**Physical scene:** *A quant on a trading desk, late, watching an autonomous agent hold live positions on a second monitor in a dim room — the screen is the only light source.* That scene forces **dark**. Dark here is identity-preservation (EdgeBot's committed deep-ink + teal/gold), not "tools look cool dark." Mercury's craft is what keeps our dark from being generic-DeFi-dark: its restraint, spacing, and number discipline are the lift.

## 2. Fonts — Google/Fontshare, with fallbacks

- **Display** (hero P&L number, section + card titles): **Clash Display** 600/700 — `'Clash Display','Satoshi',ui-sans-serif,system-ui,sans-serif`.
- **Body / UI** (labels, prose, nav): **Satoshi** 400/500/700 — `'Satoshi',ui-sans-serif,system-ui,-apple-system,sans-serif`.
- **Data / numeric utility** (P&L, prices, edges, tables, blotter, axis labels, code): **JetBrains Mono** 400/500/600 — `'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace`, always `font-variant-numeric: tabular-nums`.

Three families, each with a strict role (display / body / data) — this is Mercury's discipline (mono-forward for all data), not decoration.
**BANNED faces:** Inter, Roboto (incl. Roboto sans), Arial, Space Grotesk, Poppins.

## 3. Palette — hex · role · coverage

| Token | Hex | Role | ~Coverage |
|---|---|---|---|
| `--bg` | `#06080c` | app canvas (deep ink) | ~56% |
| `--surface` / `--surface-2` | `#0b0f16` / `#0f141d` | cards / panels / rail | ~28% |
| `--line` / `--line-2` | `#182030` / `#232d3e` | hairline dividers / borders | ~2% |
| `--ink` | `#eef2f8` | primary text + big numbers | ~7% |
| `--muted` / `--faint` | `#9aa6b8` / `#586479` | secondary / tertiary text, labels | ~3% |
| `--signal` | `#35e6c2` | THE accent: primary action, active nav, convergence line, positive P&L | ~4% |
| `--proof` | `#f2c968` | second accent, role-locked to verification/proof only | ~1.5% |
| `--neg` | `#ff7d8c` | semantic negative (losses, kill-switch) | <1% |

Accent rule (Mercury): teal appears on ~1 element per card. Gold ONLY touches proof/verify. Never both loud in the same card.

## 4. Type scale — px · spacing · line-height

| Role | Face | Size | Tracking | Line-height |
|---|---|---|---|---|
| Cockpit number (hero P&L) | Clash Display 600 | clamp(52px, 8vw, 84px) | -0.03em | 1.0 |
| — cents superscript | JetBrains Mono 500 | 0.42em of parent, baseline-shifted up | — | — |
| Section title | Clash Display 600 | clamp(26px, 3.6vw, 40px) | -0.03em | 1.05 |
| Card title | Satoshi 600 | 18px | -0.01em | 1.2 |
| Body / lede | Satoshi 400 | 15px (≤62ch) | 0 | 1.55 |
| Data / blotter / price | JetBrains Mono 400–500 | 13–14px | 0 | 1.4 |
| Uppercase label / caption | JetBrains Mono 500 | 11px | +0.06em | 1.3 |

Max **4 distinct sizes per screen region** (Mercury rule). Big number ↔ small label pairs, nothing in between shouting.

## 5. Spacing & rhythm — 4px baseline (Mercury)

Scale: `4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64`. Every margin/padding is a multiple of 4.
- Within a card: 4/8px. Card internal padding: 20–24px.
- Between sibling cards (dashboard grid gap): **20px**.
- Between panel groups (major breaks): **56–72px**.
- Card radius: **16px** (consistent, Mercury). Chips/pills: 999px. Buttons: 11–12px.

## 6. Signature hero element — "The Position Cockpit" (50% of the effort)

One full-width dashboard card at the top of the app frame — *the terminal's live position*, replacing all marketing headline copy:

- **Left column:** a status pill row (`● SETTLED · devnet · verified 6/6`, teal dot), then the **dominant realized P&L** — `+100`**`.0`**` USDC` in Clash Display at cockpit scale, cents as mono superscript, counts up once on load. Under it, two small mono readouts: `staked 158.1` · `collected 258.1`. Under that, one line naming the real market: *Argentina to win outright · fixture 18202701 · settled from the real 3–2 score*.
- **Right column (≈52% width):** the **convergence chart** — market YES climbing round-by-round toward the dashed teal fair line (72.5%), soft teal area fill fading to transparent, faint 1px grid, a gold pulse dot at the settled endpoint. This is the living signature; it must render its full curve as the DEFAULT state (motion only enhances — never gate visibility on rAF/scroll, or it ships blank on a hidden tab).
- Framed in **app chrome**: a slim top status bar (brand mark · live "devnet · block feed" ticker · `npm run judge:verify` chip) and a **narrow left icon rail** (Position / Verify / Edge / Loop / Risk) that scroll-links the panels below and shows an active state. The rail collapses to a top tab-bar under 820px.

## 7. Data-viz treatment rule (this is our "photography") — ONE consistent treatment

No photography anywhere (a data product). Every chart — hero convergence, calibration scatter, power curve, Kelly bars, P&L — uses the identical treatment:
- 2px stroke in `--signal`; soft `--signal` area fill fading to transparent top→bottom.
- faint 1px `--line` grid; axis labels in JetBrains Mono 9–10px `--faint`.
- emphasized endpoint: a filled node + a gold (`--proof`) pulse only where something is *proven/settled*.
- positive = teal, negative = `--neg`, tabular-nums throughout.
No chart gets a different palette or stroke weight. Consistency = credibility.

## 8. Layout structure

`[top status bar 48px] / [left rail 64px | main dashboard column max ~1080px]`. Main is a stack of panel-groups: **Position cockpit** → **Autonomous blotter** (the round-by-round bets table) → **Verify** (gold proof panel, 6 checks + command) → **Edge / quant** (2×2 chart cards) → **The loop** (4-step, a real sequence so numbered markers are earned) → **Risk** (Kelly + kill-switch). Footer treated as a designed status bar, not an afterthought.

## 9. Motion

- Micro-transitions: `background-color/color/border-color 0.16s ease-out` on every interactive element (Mercury value — do not invent others).
- Reveal: panels fade/rise on scroll via IntersectionObserver, but the panel is **visible by default** and the reveal only enhances; stagger children within a panel, don't apply one uniform entrance to every section.
- Hero number counts up once (900ms, ease-out-cubic). Convergence chart has a gentle live "breathe"; full curve is the default render.
- Focus ring (copy Mercury exactly): `box-shadow: 0 0 0 1px var(--bg), 0 0 0 3px color-mix(in oklab, var(--signal) 60%, transparent)`.
- Full `prefers-reduced-motion` alternative: no count-up, no breathe, instant reveals.

## 10. Banned tells (match-and-refuse)

Emoji as icons · glassmorphism as default · purple/blue gradients · gradient text (`background-clip:text`) · cards-in-cards · three-equal-icon-tile cards · centered-everything · gray text on a colored fill · side-stripe (thick `border-left`) accents · a tracked uppercase eyebrow above *every* section (one named kicker max, not per-section) · numbered `01/02/03` markers except on the genuine Loop sequence · text that overflows its container at any breakpoint.

## 11. Content — real, no lorem

All numbers, the market address, teams, per-round decisions, and settlement come from `dashboard/last-run.json` (fetched live). The market is the real settled devnet market on program `AfvTru…DbD8`. Quant figures (Brier 0.193, power N=20→10.5%, ¼-Kelly 81%, +8.89pp CI) come from `quant-study.mjs` and are labelled real vs. synthetic. Verify = the real 6-check `npm run judge:verify`.

## 12. Definition of done

Desktop (1440) and mobile (390) both flawless. Hero reads as a live terminal in the first viewport, not a pitch. Contrast ≥4.5:1 on all body text. No console errors. Passes the side-by-side craft loop (Step 5) twice and the brutal-art-director score (Step 6) at ≥8.
