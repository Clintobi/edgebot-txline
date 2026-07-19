# EdgeBot Technical Submission Documentation

## 1. What is novel

EdgeBot combines two independently verifiable mechanisms into one autonomous trading loop:

1. **Tick-to-transaction autonomy.** A persistent TxLINE SSE consumer re-prices the market on every unique 1X2 odds tick. There is no round timer and no human trigger between feed update, valuation, policy decision, and execution.
2. **Trustless proof-settlement.** The Solana program consumes TxLINE's Merkle proof through `validate_stat`, verifies the full-time goal stats, and derives YES/NO on-chain. The caller cannot supply a preferred winner.

The credential-free verifier proves both halves: it reads a previously settled public devnet market and independently re-derives its result, then replays a deterministic stream through the same repricer and verifies every policy decision's hash chain.

## 2. Reproducibility contract

The shortest judge path needs no wallet, keypair, TxLINE credential file, or environment variables:

```bash
npm ci
npm run judge:verify
```

Container equivalent:

```bash
docker compose run --rm verify
```

The command checks:

- the committed demo market exists and is settled on public Solana devnet;
- on-chain pool balances match the committed run artifact;
- the immutable settlement instruction contains the expected fixture, period-100 score proof, and canonical TxLINE CPI;
- the real TxLINE final score can be fetched again;
- the outcome derived from that score equals the on-chain resolution;
- the deterministic CLV study reproduces from the committed odds cache;
- four matching SSE events are re-priced independently;
- both ALLOW and DENY policy outcomes occur; and
- the append-only gate ledger's SHA-256 chain is internally valid.

For a completely offline look at the streaming control plane (no external RPC/API checks):

```bash
npm run daemon:replay
npm test
```

## 3. Runtime architecture

```text
TxLINE GET /api/odds/stream (SSE)
                │
                ▼
lib/sse.mjs ── parse, Last-Event-ID, reconnect/backoff
                │ one message at a time
                ▼
lib/repricer.mjs ── fixture/1X2 filter, dedupe, raw P(home), Kelly size
                │ proposed trade intent
                ▼
lib/policy-gate.mjs ── deterministic fail-closed ALLOW / DENY
                │                         │
                │ every outcome           └── hash-chained JSONL audit entry
                ▼
paper venue or opt-in Solana executor
                │
                ▼
Edgemarket program ── TxLINE validate_stat CPI ── proof-derived settlement

TxLINE GET /api/scores/stream (SSE)
                │ fixture score event
                ▼
full-time proof fetch ── permissionless settle ── winning-side claim
```

### 3.1 Stream semantics

`live-daemon.mjs` opens `GET /api/odds/stream` with:

```text
Accept: text/event-stream
Cache-Control: no-cache
Authorization: Bearer <guest JWT>
X-Api-Token: <subscription token>
```

The client supports CRLF or LF separators, comments/heartbeats, multi-line `data`, `id`, and server `retry` hints. It retains the last event ID across exponential-backoff reconnects. A fingerprint of the normalized fixture, probabilities, timestamp, and bookmaker prevents reconnect duplicates from becoming duplicate orders.

Every new matching tick causes a new chain-state read. The daemon does not reuse the market price from the previous tick.

The same process concurrently owns the score stream. It checks for an already-final
proof on startup and re-checks after every score event for its fixture. Once both
goal stats have a period-100 proof, it stops trading, submits the permissionless
settlement, re-reads the derived on-chain resolution, claims only when its audited
ledger shows exposure to the winning side, writes a lifecycle receipt, and exits.

### 3.2 Price and sizing

For a market defined as "participant 1 wins outright":

```text
fair YES = Pct[0] / 100
market YES = yes_pool / (yes_pool + no_pool)
edge(side) = fair(side) - market(side)
full Kelly = edge(side) / (1 - market(side))
stake = min(quarter Kelly, 5% per order, remaining 20% exposure room)
```

The draw remains in NO. Dropping it and renormalizing home/away would overstate the home probability.

### 3.3 Policy gate and audit ledger

Every proposed order crosses `decideTrade()` immediately before any executor call. The gate denies:

- malformed/non-finite probabilities or sizes;
- a fixture outside the explicit allowlist;
- a stale or future-dated tick;
- edge below the autonomous threshold;
- an implausibly large edge that is more likely a broken feed;
- an order above the per-order cap;
- an order that breaches aggregate exposure; or
- any order after the kill switch is active.

ALLOW and DENY decisions are appended to JSONL with the full intent, reasons, execution status, previous hash, and entry hash. The next record commits to the prior record. `verifyGateLedger()` detects either content tampering or row deletion/reordering inside the chain.

The exposure total is reconstructed from executed ledger records after a daemon restart, so restarting the process does not reset its risk budget.
Previously seen event/tick fingerprints are also reconstructed, preventing a
replayed SSE event after restart from becoming a duplicate order. The daemon
refuses to start if the existing ledger hash chain is invalid.

## 4. Public live execution evidence

On 19 July 2026 the daemon connected concurrently to the real TxLINE odds and
score streams for Spain v Argentina (`18257739`). The first received 1X2 tick was
DENIED because its 2.335pp discrepancy was below policy. After the independent
operator supplied additional disclosed NO-side liquidity, a subsequent real tick
produced:

| Field | Value |
| --- | --- |
| SSE event ID | `1784469300000:10194` |
| TxLINE raw 1X2 | 31.046 / 48.286 / 20.678 |
| Fresh market pools | 100 YES / 300 NO |
| Market YES | 25.000% |
| Edge | +6.046pp YES |
| Decision | ALLOW |
| Quarter-Kelly amount | 20.153333 test USDC |
| Ledger head | `2b434c274e7f4e05c18d727def57147993a3a57bcde46af34c9b137d59442279` |
| Devnet transaction | `4qfLpfiXnZ8vUo7BbpLkTR2BjXGryoAS1Hx7XbFQc9WDg5YGbrckfN7UM3GpNXFnSpDudCVNyKaFBrxf1eTBRSCc` |

The public evidence bundle is `evidence/live-daemon-proof-2026-07-19.json`.
`judge:verify` validates its raw tick fingerprint, ledger chain and receipt link,
then independently fetches the devnet transaction and decodes its instruction bytes to prove the exact side and amount. This remains valid if later transactions change the market account.

## 5. Operating modes

### Credential-free deterministic replay

```bash
npm run daemon:replay
```

This runs the real SSE parser, repricer, policy gate, paper executor, and ledger against `test/fixtures/odds-replay.sse`. The fixture includes four target-market ticks and one unrelated fixture tick. The unrelated event is ignored; all four relevant events are independently processed.

### Live stream with paper execution

```bash
FIXTURE=<txline-fixture-id> \
CREDS=txline-creds.json \
npm run daemon
```

This is the safe default for observing a live stream. It uses real TxLINE ticks while keeping execution local.

### Live stream with on-chain execution

```bash
FIXTURE=<txline-fixture-id> \
CREDS=txline-creds.json \
EDGEBOT_KEYPAIR=edgebot-trader.json \
MINT=<token-2022-mint> \
EXECUTION=onchain \
npm run daemon
```

On-chain mode derives the market PDA from the fixture, reads current pool state from devnet for every tick, builds `deposit_yes` or `deposit_no`, and signs only after an ALLOW decision. No keypair path is embedded in the source.

Useful policy overrides are `MIN_EDGE`, `MAX_PLAUSIBLE_EDGE`, `MAX_SIGNAL_AGE_MS`, `MAX_POSITION`, `MAX_EXPOSURE`, and `GATE_LEDGER`.

## 6. Trustless settlement

Markets are bound to a real TxLINE fixture ID and goal stat keys `1` and `2`. Settlement accepts a TxLINE validation proof, not a boolean winner argument. The program CPI-validates both period-100 stats and derives:

```text
YES if goals_1 > goals_2
NO otherwise (draw or participant 2 win)
```

Settlement is permissionless. If a full-time proof is unavailable, the agent refuses to settle.

## 7. Security and failure behavior

- The judge path is read-only and never loads a wallet.
- Live paper mode needs feed credentials but no wallet.
- On-chain execution is opt-in and requires explicit `EDGEBOT_KEYPAIR` and `MINT` values.
- `.dockerignore` excludes `.env`, JSONL audit files, `data`, and Git metadata.
- Stream disconnects trigger bounded exponential reconnect with Last-Event-ID.
- Parser, gate, repricer, Kelly logic, settlement derivation, and ledger tamper detection have deterministic tests.
- An executor error arms the in-memory kill switch; later intents fail closed.

## 8. File map

| File | Responsibility |
| --- | --- |
| `live-daemon.mjs` | persistent stream orchestration, venue adapters, one-intent-at-a-time execution |
| `bootstrap-market.mjs` | independent operator market/mint setup for a fresh fixture |
| `add-liquidity.mjs` | explicit operator-owned liquidity adjustment |
| `lib/sse.mjs` | SSE parser and reconnecting async iterator |
| `lib/repricer.mjs` | tick normalization, dedupe fingerprint, market comparison, Kelly sizing |
| `lib/policy-gate.mjs` | deterministic pre-trade policy and tamper-evident ledger |
| `verify.mjs` | zero-wallet public-chain/result/backtest/daemon verifier |
| `agent-live.mjs` | independent operator/trader devnet proof-settle demonstration |
| `program/programs/edgemarket/src/lib.rs` | execution venue and TxLINE proof-settlement CPI |
| `Dockerfile`, `compose.yaml` | one-command reproducible judge environment |

## 9. Honest limitations

- The included SSE replay is deterministic evidence of control-flow correctness, not a claim that a World Cup fixture is live during judging.
- Live stream access requires a TxLINE subscription token; the public verifier intentionally does not.
- The demonstration token is test USDC on devnet, not mainnet USDC.
- The 20-fixture real-data CLV sample is underpowered; the README and quant report disclose that its confidence interval spans zero.
