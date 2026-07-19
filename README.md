# EdgeBot — an autonomous market-making agent for on-chain sports markets

**TxODDS × Solana World Cup Hackathon · Trading Tools and Agents track**

EdgeBot is an autonomous agent a trading desk or market operator can deploy to **make markets** on
football match outcomes. It ingests TxLINE's live demargined odds over a persistent SSE stream,
prices and quotes two-sided liquidity anchored to that sharp line, and sizes and executes on Solana
behind a tamper-evident policy gate — no human in the loop. Its defined strategy is inventory-aware
**market-making** (with a simple directional value mode); its differentiator is what happens at the
end: **each market settles from TxLINE's cryptographic proof of the real result — so the markets it
runs are provably fair, with no admin and nobody, not even the operator, able to pick the winner.**

Anyone can audit that a market settled honestly: `npm run judge:verify` needs **no wallet, keypair,
API credential, or environment setup**. It re-derives the public devnet settlement from the real
score, reproduces the studies, replays per-tick pricing, and verifies the policy ledger's hash chain.

**Who it's for:** a trading desk, a prediction-market / sportsbook operator, or a B2B intermediary
that wants an autonomous agent to run sports markets — **with settlement nobody has to trust.**

**Demo video (≤5 min):** https://youtu.be/n2OlWOnD7Yk
**Dashboard (application access):** https://edgebot-txline.vercel.app

## What's novel here — and what isn't

A quant judge deserves precision, so: **the trading strategy is deliberately simple and is
*not* the contribution.** Fair = raw demargined home probability, edge = fair − market price,
size = quarter-Kelly, act if `|edge| > 3%`. That is a textbook value rule any quant could write
in an afternoon, and we don't dress it up as more.

What is genuinely worth judging:

- **Trustless CPI proof-settlement.** The winner is derived *on-chain* from a TxLINE Merkle
  proof — no admin, and nobody (including us) can type the outcome in. This is rare.
- **A zero-credential verifier.** `npm run judge:verify` re-derives every claim from public
  devnet + real TxLINE with no wallet, key, or account. Trust is falsifiable, not asserted.
- **A per-tick SSE → fail-closed policy gate → hash-chained audit ledger** control plane.

The strategy is the plumbing test; the **settlement and verification layers are the point.** The
demos below prove the *mechanism* runs end to end — they are not, and are not claimed to be,
evidence of a profitable trading edge (see the honest CLV read further down).

## Signal → decision → execution → honest settlement

1. **Stream** TxLINE odds over persistent SSE. Each unique 1X2 event triggers a
   fresh chain-state read and valuation; reconnects resume with `Last-Event-ID`.
2. **Fair price.** For a "team1 wins outright" market, `P(YES) = part1 / 100` —
   the **raw** home-win probability. The draw and the away win both belong in NO,
   so we do **not** renormalize to a two-way (that would inflate the favourite —
   e.g. a true 72.5% becomes a fictitious ~90%).
3. **Market price**: read the on-chain market account → `YES = yes/(yes+no)`.
4. **Edge** `= fair − market`. If `|edge| > 3%`, stake the underpriced side.
   Size with **fractional (quarter) Kelly**: `f* = (p − q)/(1 − q)`, stake
   `0.25·f*` of bankroll, capped per-position (5%) and in aggregate (20%). Else **HOLD**.
5. **Policy gate / audit**: every intent fails closed on malformed or stale data,
   fixture allowlist, edge sanity, per-order size, and aggregate exposure. Every
   ALLOW or DENY is appended to a SHA-256-linked JSONL ledger.
6. **Execute**: submit `deposit_yes`/`deposit_no` only after ALLOW. The next odds
   tick repeats the full stream → fresh price → gate → execution path.
7. **Settle from the real result.** After the match, EdgeBot fetches TxLINE's
   **finalised score** (goal stat keys `1`,`2`), derives the outcome, and settles
   the market on **what actually happened** — it never passes a chosen outcome. If
   the fixture is not finalised, it refuses to settle.

Fully autonomous: the inputs are the live odds and on-chain state; the outcome is
the real score. No human picks the winner.

## Live per-tick autonomy + auditable control plane

```bash
npm run daemon:replay  # zero credentials: 4 SSE ticks → 4 valuations → gate ledger

# real TxLINE SSE, safe paper executor:
FIXTURE=<fixture> CREDS=txline-creds.json npm run daemon

# opt-in real devnet deposits (explicit wallet and market mint):
FIXTURE=<fixture> CREDS=txline-creds.json EDGEBOT_KEYPAIR=trader.json \
MINT=<token-2022-mint> EXECUTION=onchain npm run daemon
```

The stream client handles chunk boundaries, heartbeats, multiline data, retry
hints, exponential reconnect, and replay deduplication. The risk budget survives
restarts because exposure is reconstructed from executed audit records. See
[`SUBMISSION_TECHNICAL_DOCUMENTATION.md`](SUBMISSION_TECHNICAL_DOCUMENTATION.md).

### Public live SSE → policy → transaction proof (19 July 2026)

This is no longer replay-only evidence. For TxLINE fixture `18257739` (Spain v
Argentina), the daemon received live 1X2 SSE event `1784469300000:10194`:

```text
TxLINE P(Spain win): 31.046%     fresh on-chain YES price: 25.000%
edge: +6.046pp                   policy: ALLOW
quarter-Kelly deposit: 20.153333 test USDC on YES
```

Full disclosure of where the edge came from: the operator supplied 100 YES / 300 NO test-USDC
and **moved the price by adding liquidity between ticks** — so the +6.046pp gap was *created by
the operator, not discovered* in an independent market. This is a disclosed mechanism
demonstration. What it legitimately shows is that the live SSE → policy → transaction path fires
only when the threshold is met: an earlier tick at a 33.333% price gave just 2.335pp and was
**DENIED**, so the gate was not relaxed for the demo.

The successful deposit is public on devnet:
[`4qfLpfi…BRSCc`](https://explorer.solana.com/tx/4qfLpfiXnZ8vUo7BbpLkTR2BjXGryoAS1Hx7XbFQc9WDg5YGbrckfN7UM3GpNXFnSpDudCVNyKaFBrxf1eTBRSCc?cluster=devnet).
The sanitized raw event, both linked gate decisions, and transaction receipt are
committed in [`evidence/live-daemon-proof-2026-07-19.json`](evidence/live-daemon-proof-2026-07-19.json).
`npm run judge:verify` independently fingerprints the raw event, checks the ledger
chain, fetches the transaction, confirms its trader/market/program accounts, and
checks that the gated amount landed in the market pools.

## Mechanism demo (devnet) — the loop, end to end

**Read this as a mechanism demonstration, not an edge.** On devnet there is no liquid
counterparty market, so the operator *seeds* the market away from fair value — which means the
mispricing EdgeBot trades here is **manufactured by the seed, not discovered.** What it proves
is that the full loop — price → gate → execute → proof-settle → claim — runs autonomously and
settles on the real score. Whether the strategy has alpha is a separate question, answered
(honestly, and inconclusively at N=20) by the CLV section below.

Market: **"Argentina to win outright"**, TxLINE fixture `18202701` (Argentina finished
**3–2**). The operator seeded 100 USDC on NO as a disclosed counterparty price; TxLINE's
demargined closing line put **P(Argentina win) at 72.5%** (1X2 = 72/19/8) while the seeded
market opened at YES = 0%, so EdgeBot bought YES down the (operator-created) gap:

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

The +100 is real capital settling on the real score — but it is a **product of the operator's
seed, not proof that EdgeBot beats an efficient market.** The agent profits because the side it
staked matched the finalised result; ask "how do you know it won?" → "TxLINE's finalised score
says 3–2." Execution venue: [`AfvTru…DbD8`](https://explorer.solana.com/address/AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8?cluster=devnet)
(devnet) · live dashboard: https://edgebot-txline.vercel.app

## Proven edge — CLV backtest (`backtest.mjs`)

A single winning demo proves nothing; **closing-line value (CLV)** does — it measures skill
independent of short-run luck. Run over **20 real finished fixtures** (pre-KO demargined 1X2
tick history vs the real result), graded with the rigour a quant judge expects: a **seeded
bootstrap 95% CI**, a **walk-forward** out-of-sample split, and a **calibration** check.

**1 · Book sharpness — the robust result.** The demargined **closing line's Brier score is
0.193 vs a 0.240 base rate** (lower = sharper). The price EdgeBot bets *toward* is genuinely
sharp; *if* a naive market misprices against it, arbitraging that gap is +EV in expectation —
but whether such a gap exists in the wild is exactly what N=20 cannot yet confirm (below).
The report prints a reliability table (predicted vs actual win-rate per probability bin).

**2 · Walk-forward CLV — the honest, non-cherry-picked test.** We select the strategy on the
in-sample prefix and grade it *out of sample*. At N=20 the OOS mean-CLV bootstrap CI **still
spans zero — directional, not yet significant**, and we report that rather than quoting the
best in-sample number (an in-sample "fade" sweep shows +8.96% CLV, but that's cherry-picked and
its CI also includes zero). The rigour is the point, and it scales to the full fixture history.

This is deliberately the *same* honest posture as the strongest competing agents: nobody has a
statistically significant CLV at this sample. What EdgeBot adds is **not a bigger edge claim** —
it is real on-chain capital execution and trustless settlement that the paper-only agents lack.

## Full quant dossier (`quant-study.mjs` · `npm run quant`)

The backtest above is the headline; `npm run quant` is the rigour a TxODDS quant will actually
probe. Everything is either measured on the real fixtures or a **seeded Monte-Carlo on a model
fit to real data and validated against it** before any conclusion is drawn:

- **Calibration (real):** Brier **0.193** vs 0.240 (skill **+0.195**); Murphy decomposition
  (reliability 0.063 / resolution 0.109 / uncertainty 0.240); logistic calibration slope **0.89**.
- **Model validation:** drawing outcomes `~Bernoulli(close)` reproduces Brier **0.177 vs 0.193** —
  the gap *is* the measured small-sample miscalibration, so the simulator is faithful, not tuned.
- **Large-N (synthetic, labelled):** 50k markets → mean CLV **+8.89pp**, 95% CI [+8.85, +8.93].
  **Heavy caveat:** the generative model is fit to the *same ~20 real fixtures*, so this only shows
  how the mechanism behaves *under that fitted model* — it is an illustration, **not independent
  evidence**, and it cannot manufacture significance the real N=20 can't support.
- **Power analysis — the honest core:** real N=20 has only **10.5% power**, so a non-significant
  result is *expected*, not evidence of no edge. Confirming it needs **N≈200** finished fixtures —
  which the gated free-tier endpoints don't allow, the same ceiling for every competitor.
- **Kelly study:** quarter-Kelly captures **81%** of full-Kelly log-growth with **0% ruin** and
  ~40% less drawdown — the empirical justification for the shipped sizing.
- **Sensitivity:** log-growth is positive across every edge-threshold × Kelly-fraction cell.

Visual dossier (charts): the "EdgeBot — Quant Dossier" page. Reproduce it all locally with
`npm run quant` — seeded, no keys, deterministic.

## Market-making mode (`marketmaker.mjs`) — a design, not a profit claim

The directional value rule is deliberately simple. The more sophisticated — and more honest —
design is to stop *taking* and start *making*: quote **both** sides of the market anchored to the
live TxLINE fair, skew the quotes by inventory (a simplified Avellaneda–Stoikov reservation price
in [`lib/mm.mjs`](lib/mm.mjs)), widen them when the line is volatile, and earn the bid–ask spread
while the sharp closing line does price discovery. Settlement stays trustless. This also reframes
the awkward "we supply the liquidity" fact from the demos: **providing liquidity is a market
maker's job, not an embarrassment.**

`npm run marketmaker` backtests the design on the same real fixtures and **decomposes P&L into
gross spread captured vs adverse selection**, under a clearly-labelled *synthetic* taker-flow
model (Glosten–Milgrom: a tunable fraction of informed flow marks against the maker; the rest is
noise). It is not real order flow, so it is **not evidence the maker is profitable** — it is the
honest market-maker tension:

| informed flow | gross spread | adverse selection | net P&L |
|---|---:|---:|---:|
| 0% (pure noise) | +3404 | −306 | **+3098** (20/20 fixtures) |
| 20% | +3404 | −5940 | −2535 |
| 40% (default) | +3404 | −8737 | −5333 |
| 60% | +3404 | −10635 | −7231 |

Spread income is constant and real; adverse selection scales with informed flow; **net
profitability is entirely a function of the flow mix — which no synthetic backtest can settle.**
That honest tension, not a printed number, is the point. `lib/mm.mjs` is unit-tested; the run is
seeded and cache-only.

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

`EDGEBOT_KEYPAIR` is optional here: provide it for a persistent trader identity,
or the demo creates an ephemeral independent trader. There is no machine-specific path.

## Verify it yourself — no trust required

```bash
npm run judge:verify   # re-checks the last run from PUBLIC devnet RPC + real TxLINE + this repo
npm test               # unit suite over the pure quant logic (lib.mjs)
```

`judge:verify` needs no keys and no wallet. It reads the market straight off public devnet,
confirms it is **Settled**, re-fetches the **real TxLINE final score**, re-derives the outcome,
and checks that the **on-chain resolution equals the derived outcome** (proving the winner was
never a number we typed in), that the pools match the reported run, and that the CLV backtest
**reproduces** from the committed cache. It also runs the per-tick daemon replay and verifies
that its ALLOW/DENY ledger is hash-chain intact. `npm test` covers SSE chunking, tick filtering,
fresh repricing, fail-closed policy rules, ledger tamper detection, Kelly sizing, CLV, outcome
derivation, and Brier.

The current verifier reports **14 independent checks**, including the captured
live SSE → policy hash → successful devnet transaction chain.

Watch the ≤5-min demo: **https://youtu.be/n2OlWOnD7Yk** (script: [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md)).

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT.
- `GET /api/odds/snapshot/{fixtureId}` (live) and `GET /api/odds/updates/{fixtureId}`
  (tick history, so the pre-match closing line is recoverable after kickoff) — odds → fair probability.
- `GET /api/scores/snapshot/{fixtureId}` — finalised score (goal keys `1`,`2`) → real settlement outcome.

## Run it

```bash
npm install
# zero-setup judge path (no wallet, keypair, TxLINE credentials, or env vars):
npm run judge:verify

# identical one-command container path:
docker compose run --rm verify

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

## Oracle risk & limitations — read before trusting it with value

Honesty about the boundaries, because a serious reviewer will ask:

- **Single-oracle trust.** Settlement is only as correct as TxLINE's `validate_stat` proof. There
  is **no fallback oracle.** The trustlessness is *"the winner is derived from the proof, not
  typed in"* — **not** *"the proof is guaranteed true."* If TxLINE returned a wrong proof, the
  contract would settle on it. Production would need a second oracle or a dispute window.
- **Fail-safe on absence, not on error.** With no full-time (period 100) proof, the contract
  **refuses to settle** — funds stay locked rather than resolve wrong, so an outage *delays*
  settlement, it doesn't misresolve. Bad *data*, however, is trusted (see above).
- **Devnet only.** A devnet demonstration: no mainnet deployment, no real value. The Anchor
  program has **no professional audit** and no emergency-pause authority yet.
- **Statistical limits.** The edge is directional at N=20 (CI spans zero); the value strategy is
  intentionally simple; the market-making figures use *synthetic* flow. None of it is a
  risk-of-capital recommendation, and this is **not financial advice**.

## Roadmap

Built this round: persistent per-tick SSE repricing, reconnect/deduplication,
policy-gated execution, a hash-chained decision ledger, CLV backtest, quarter-Kelly
sizing, exposure caps, credential-free verifier, containerized reproduction, CI
(deterministic + reproducibility jobs), and an inventory-aware market-making design
with an honest spread-vs-adverse-selection decomposition. Next: validate the maker
against real (not synthetic) taker flow, a pre-settlement exit on edge reversal, and
a monitoring page for equity, rolling CLV, exposure, and gate state.

## Design credit

The dashboard's layout and interaction craft are modeled on Mercury's product dashboard
(mercury.com); the colour palette, brand, wordmark, and all content are EdgeBot's own, and the
UI is **not** claimed as a novel contribution. It exists only to make the verifier and
settlement evidence legible.
