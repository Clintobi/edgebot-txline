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
Execution venue: [`37Gjug…9vTW`](https://explorer.solana.com/address/37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW?cluster=devnet)
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

## Settlement integrity

EdgeBot currently settles via `admin_settle(realOutcome)` where `realOutcome` is
**derived from TxLINE's finalised score**, so the agent can never pay itself on an
invented result. The stronger form — routing settlement through the on-chain
`validate_stat` Merkle-proof CPI so *anyone* can verify the outcome trustlessly —
is the Track-1 (`fulltime-prediction-markets`) settle path; EdgeBot consumes the
same TxLINE result data.

## Roadmap

Built this round: CLV backtest, quarter-Kelly sizing, exposure caps, and a
feed-health/exposure kill-switch. Next: a persistent SSE daemon that re-prices per
tick on the live stream; two-sided market making with pre-settlement exit on edge
reversal; a monitoring page (equity curve, rolling CLV, open exposure, kill-switch state).
