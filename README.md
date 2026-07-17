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
4. **Edge** `= fair − market`. If `|edge| > 3%`, stake the underpriced side,
   sized ∝ edge (capped). Else **HOLD**.
5. **Execute**: submit a `deposit_yes`/`deposit_no` transaction. Repeat.
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

CLV (closing-line-value) backtest to quantify edge; quarter-Kelly sizing with
exposure caps + a drawdown kill-switch; a persistent SSE daemon that re-prices per
tick; two-sided market making with pre-settlement exit on edge reversal.
