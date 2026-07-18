# EdgeBot — Autonomous Odds-Driven Trading Agent

**TxODDS × Solana World Cup Hackathon · Trading Tools and Agents track**

EdgeBot ingests TxLINE odds, computes each side's fair win probability, compares
it to an **on-chain prediction market's pool-implied price**, and **autonomously
stakes USDC on the mispriced (+EV) side** — no manual input. It re-evaluates in a
loop until the market converges to fair value, then **settles the market from the
real match result fetched from TxLINE** and collects.

**Dashboard (application access):** https://edgebot-txline.vercel.app

## Signal → decision → execution → honest settlement

1. **Ingest** TxLINE odds. The `TXLineStablePriceDemargined` book gives fair
   implied probabilities directly (`Pct = [part1, draw, part2]`).
2. **Fair price.** For a "team1 wins outright" market, `P(YES) = part1 / 100` —
   the **raw** home-win probability. The draw and the away win both belong in NO,
   so we do **not** renormalize to a two-way (that would inflate the favourite —
   e.g. a true 72.5% becomes a fictitious ~90%).
3. **Market price**: read the on-chain market account → `YES = yes/(yes+no)`.
4. **Edge** `= fair − market`. If `|edge| > 3%`, stake the underpriced side.
   Size with **fractional (quarter) Kelly**: `f* = (p − q)/(1 − q)`, stake
   `0.25·f*` of bankroll, capped per-position (5%) and in aggregate (20%). Else **HOLD**.
5. **Risk / kill-switch**: never trade on a stale or malformed signal, and halt once the
   aggregate exposure cap is hit — a desk does not trade blind or unbounded.
6. **Execute**: submit a `deposit_yes`/`deposit_no` transaction. Repeat.
6. **Settle from the real result.** After the match, EdgeBot fetches TxLINE's
   **finalised score** (goal stat keys `1`,`2`), derives the outcome, and settles
   the market on **what actually happened** — it never passes a chosen outcome. If
   the fixture is not finalised, it refuses to settle.

Fully autonomous: the inputs are the live odds and on-chain state; the outcome is
the real score. No human picks the winner.

## Live demo (devnet) — a real, finished fixture

Market: **"Argentina to win outright"**, TxLINE fixture `18202701` (Argentina
finished **3–2**). Counterparty liquidity of 100 USDC was seeded on the NO side so
the market is tradeable on devnet (this is honestly labelled as liquidity, not a
signal). TxLINE's demargined closing line put **P(Argentina win) at 72.5%**
(1X2 = 72/19/8) while the market opened at YES = 0%, so EdgeBot bought YES down the
shrinking edge:

| round | fair | market YES | edge | action |
|---|---|---|---|---|
| 1 | 72.5% | 0.0%  | +72.5% | BUY Argentina 40.0 |
| 2 | 72.5% | 28.6% | +43.9% | BUY Argentina 40.0 |
| 3 | 72.5% | 44.4% | +28.0% | BUY Argentina 28.0 |
| 4 | 72.5% | 51.9% | +20.5% | BUY Argentina 20.5 |
| 5 | 72.5% | 56.2% | +16.2% | BUY Argentina 16.2 |
| 6 | 72.5% | 59.1% | +13.3% | BUY Argentina 13.3 |

**Then it closes the loop honestly.** EdgeBot fetches the real TxLINE result —
**Argentina 3–2 → resolves YES** — settles the market on that score, and claims:

```
staked (6 autonomous bets):  158.1 USDC
real result:                 Argentina 3–2  ->  YES
collected:                   258.1 USDC
realized P&L:               +100.0 USDC   ← settled on the REAL score from TxLINE,
                                            not an outcome the agent chose
```

The agent only profits because the side it staked (Argentina) matched the real
result. Ask "how do you know it won?" → "TxLINE's finalised score says 3–2."
Execution venue: [`AfvTru…DbD8`](https://explorer.solana.com/address/AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8?cluster=devnet)
(devnet) · live dashboard: https://edgebot-txline.vercel.app

## Proven edge — CLV backtest (`backtest.mjs`)

A single winning demo proves nothing; **closing-line value (CLV)** does — it measures skill
independent of short-run luck. Run over **20 real finished fixtures** (pre-KO demargined 1X2
tick history vs the real result), graded with the rigour a quant judge expects: a **seeded
bootstrap 95% CI**, a **walk-forward** out-of-sample split, and a **calibration** check.

**1 · Book sharpness — the robust result.** The demargined **closing line's Brier score is
0.193 vs a 0.240 base rate** (lower = sharper). The price EdgeBot bets *toward* is genuinely
sharp, so arbitraging a naive market against it is real +EV — not just the demo's seeded gap.
The report prints a reliability table (predicted vs actual win-rate per probability bin).

**2 · Walk-forward CLV — the honest, non-cherry-picked test.** We select the strategy on the
in-sample prefix and grade it *out of sample*. At N=20 the OOS mean-CLV bootstrap CI **still
spans zero — directional, not yet significant**, and we report that rather than quoting the
best in-sample number (an in-sample "fade" sweep shows +8.96% CLV, but that's cherry-picked and
its CI also includes zero). The rigour is the point, and it scales to the full fixture history.

This is deliberately the *same* honest posture as the strongest competing agents: nobody has a
statistically significant CLV at this sample — the difference is that our edge sits on top of
**real on-chain capital execution**, which the paper-only agents don't have.

## Full quant dossier (`quant-study.mjs` · `npm run quant`)

The backtest above is the headline; `npm run quant` is the rigour a TxODDS quant will actually
probe. Everything is either measured on the real fixtures or a **seeded Monte-Carlo on a model
fit to real data and validated against it** before any conclusion is drawn:

- **Calibration (real):** Brier **0.193** vs 0.240 (skill **+0.195**); Murphy decomposition
  (reliability 0.063 / resolution 0.109 / uncertainty 0.240); logistic calibration slope **0.89**.
- **Model validation:** drawing outcomes `~Bernoulli(close)` reproduces Brier **0.177 vs 0.193** —
  the gap *is* the measured small-sample miscalibration, so the simulator is faithful, not tuned.
- **Large-N (synthetic, labelled):** 50k markets → mean CLV **+8.89pp**, 95% CI [+8.85, +8.93]
  (clears zero); P&L **+1.93pp/bet**.
- **Power analysis — the honest core:** real N=20 has only **10.5% power**, so a non-significant
  result is *expected*, not evidence of no edge. Confirming it needs **N≈200** finished fixtures —
  which the gated free-tier endpoints don't allow, the same ceiling for every competitor.
- **Kelly study:** quarter-Kelly captures **81%** of full-Kelly log-growth with **0% ruin** and
  ~40% less drawdown — the empirical justification for the shipped sizing.
- **Sensitivity:** log-growth is positive across every edge-threshold × Kelly-fraction cell.

Visual dossier (charts): the "EdgeBot — Quant Dossier" page. Reproduce it all locally with
`npm run quant` — seeded, no keys, deterministic.

## Trading a market it didn't make (`agent-live.mjs`)

The seeded-liquidity demo above is a controlled showcase; this is the answer to *"is that a
real market?"* `agent-live.mjs` splits the actors into two independent on-chain wallets: an
**operator** ("the house") creates the market and provides the opposing liquidity, and
**EdgeBot** — its own wallet — only reads the price, sizes with Kelly, and takes the +EV side.
Settlement is a **permissionless proof-settle** (CPI to `validate_stat`), so no one types in
the outcome.

Verified on devnet (fixture 18185036, home an 18% underdog that lost 0–3): the operator seeded
the home side; EdgeBot's model priced the home win at 16%, saw the market grossly overpricing
it, and took **NO** across five quarter-Kelly bets to a 20% exposure cap; the market settled
**NO** from the TxLINE proof; EdgeBot claimed **+100 USDC** — trading a market it did not
create, against an independent counterparty (two distinct wallets, both on Explorer).

```bash
OPERATOR_KEYPAIR=deployer.json CREDS=txline-creds.json FIXTURE=<fresh finished fixture> node agent-live.mjs
```

## Verify it yourself — no trust required

```bash
npm run judge:verify   # re-checks the last run from PUBLIC devnet RPC + real TxLINE + this repo
npm test               # unit suite over the pure quant logic (lib.mjs)
```

`judge:verify` needs no keys and no wallet. It reads the market straight off public devnet,
confirms it is **Settled**, re-fetches the **real TxLINE final score**, re-derives the outcome,
and checks that the **on-chain resolution equals the derived outcome** (proving the winner was
never a number we typed in), that the pools match the reported run, and that the CLV backtest
**reproduces** from the committed cache. `npm test` covers `lib.mjs` — raw fair prob (the
draw-bug fix), Kelly sizing, CLV, outcome derivation, Brier.

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT.
- `GET /api/odds/snapshot/{fixtureId}` (live) and `GET /api/odds/updates/{fixtureId}`
  (tick history, so the pre-match closing line is recoverable after kickoff) — odds → fair probability.
- `GET /api/scores/snapshot/{fixtureId}` — finalised score (goal keys `1`,`2`) → real settlement outcome.

## Run it

```bash
npm install
# run against a finished fixture — the full loop completes in one pass:
DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json REAL_FIXTURE=18202701 node agent.mjs

# or against an upcoming match once it finishes (both teams named):
#   France v England:      REAL_FIXTURE=18257865
#   Final Spain v Argentina: REAL_FIXTURE=18257739

# CLV backtest (cache the pre-KO odds once, then it's instant + re-runnable):
CREDS=txline-creds.json node fetch-odds-cache.mjs   # builds /tmp/edgebot-odds-cache.json
node backtest.mjs                                   # CLV + book-sharpness report

# demo the kill-switch halting on a bad/stale feed:
DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json REAL_FIXTURE=18179549 KILL_TEST=stale node agent.mjs
```

Because both the odds tick history and the finalised score stay available after a
match, one run reproduces the whole signal → settle loop for any finished fixture.

## Settlement integrity — trustless by default

EdgeBot settles through the on-chain **`validate_stat` Merkle-proof CPI**: the program
proves the two goal stats (keys `1`,`2`) against TxLINE's oracle and **derives the winner
from that proof**. The agent never passes a chosen outcome, the call needs no admin
authority (**anyone can settle**), and if no full-time (period 100) proof exists yet it
**refuses to settle**. This is the same trustless path Track 1
(`fulltime-prediction-markets`) uses — EdgeBot now runs it as its own default, so the
main `agent.mjs` loop, not just the `agent-live.mjs` showcase, closes the loop trustlessly.

Because the proof binds a market to its real fixture, proof-settle markets are **single-use
per fixture** (a settled real event can't be re-opened) and the market is seeded by the
real TxLINE fixture id.

## Roadmap

Built this round: CLV backtest, quarter-Kelly sizing, exposure caps, and a
feed-health/exposure kill-switch. Next: a persistent SSE daemon that re-prices per
tick on the live stream; two-sided market making with pre-settlement exit on edge
reversal; a monitoring page (equity curve, rolling CLV, open exposure, kill-switch state).
