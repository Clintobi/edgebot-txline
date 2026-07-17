# EdgeBot — Autonomous Odds-Driven Trading Agent

**TxODDS × Solana World Cup Hackathon · Trading Tools and Agents track**

EdgeBot ingests TxLINE live odds, computes each side's fair win probability,
compares it to an **on-chain prediction market's pool-implied price**, and
**autonomously stakes USDC on the mispriced (+EV) side** — no manual input. It
re-evaluates in a loop and stops when the market has converged to fair value.

**Dashboard (application access):** https://edgebot-txline.vercel.app

## Signal → decision → execution

1. **Ingest** TxLINE odds (`/api/odds/stream` live, `/api/odds/snapshot`
   fallback). The `TXLineStablePriceDemargined` book gives fair implied
   probabilities directly (`Pct`).
2. **Fair price**: renormalize the 1X2 to a two-way, e.g. `P(Spain) = 61.5%`.
3. **Market price**: read the on-chain market account → `YES = yes/(yes+no)`.
4. **Edge** `= fair − market`. If `|edge| > 3%`, stake the underpriced side,
   sized ∝ edge (capped). Else **HOLD**.
5. **Execute**: submit a `deposit_yes`/`deposit_no` transaction. Repeat.

Fully autonomous — inputs are only the live odds and on-chain state; the loop
runs and executes with no human in the loop.

## Live demo (devnet)

A noise trader mispriced a Spain-vs-Argentina market to **YES = 0%** (all stake on
Argentina) while TxLINE's fair price for Spain was **61.5%**. EdgeBot corrected it
over 6 on-chain rounds, sizing each bet to the shrinking edge:

| round | fair | market YES | edge | action |
|---|---|---|---|---|
| 1 | 61.5% | 0.0% | +61.5% | BUY 40 |
| 2 | 61.5% | 28.6% | +33.0% | BUY 33 |
| 3 | 61.5% | 42.2% | +19.3% | BUY 19.3 |
| 4 | 61.5% | 48.0% | +13.5% | BUY 13.5 |
| 5 | 61.5% | 51.4% | +10.1% | BUY 10.1 |
| 6 | 61.5% | 53.7% | +7.8% | BUY 7.8 |

**Then it closes the loop.** The match resolves Spain-win, the market settles, and
the agent collects:

```
staked (6 autonomous bets):  123.8 USDC
collected on win:            223.8 USDC
realized P&L:               +100.0 USDC   ← the counterparty's stake
```

Signal → autonomous execution → settlement → **realized profit**. Execution venue:
[`37Gjug…9vTW`](https://explorer.solana.com/address/37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW?cluster=devnet) (devnet) · live dashboard: https://edgebot-txline.vercel.app

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT.
- On-chain `subscribe(serviceLevel=1, weeks=4)` + `POST /api/token/activate` — API token (`subscribe.mjs`).
- `GET /api/odds/snapshot/{fixtureId}` (+ `/api/odds/stream` live) — odds → fair probability.

## Run it

```bash
npm install
# 1) get a TxLINE API token (on-chain subscribe + activate)
DEPLOYER_KEYPAIR=deployer.json node subscribe.mjs
# 2) run the agent
DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json node agent.mjs
```

## During real matches

Pre-match odds are sparse; during a live match EdgeBot consumes TxLINE's
continuous odds stream and re-prices every tick — reacting to goals in real
time. The `LIVE` tag in logs shows live-pull vs. last-observed cache.

## TxLINE API feedback

**Liked:** the demargined odds book returns clean implied probabilities, so the
signal layer is trivial; one normalised schema across scores/odds/fixtures. SSE
is genuinely real-time. **Friction:** odds/scores snapshots are transient
pre-match (empty between pushes), so an agent must cache the last-seen tick and
rely on the stream during play; data access needs the on-chain subscribe +
`/api/token/activate` handshake before anything returns (403 until then).

## Roadmap

Two-sided market making (quote both sides); exit logic (sell before settlement on
edge reversal); Kelly sizing; persistent daemon; integrate TxLINE's native
on-chain trading instructions (`create_trade` / `validate_odds` / `settle_trade`).
