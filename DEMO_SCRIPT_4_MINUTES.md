# EdgeBot — Four-Minute Demo Script

Editorial target: 3:50–4:00 total runtime, one continuous argument, no dead air.
The video should feel like a trading-system proof, not a feature tour: show a
real feed event, show the autonomous decision seam, show the public transaction,
then let the verifier audit your claims.

## Before recording (do this off-camera)

Open three windows and arrange them as a clean 60/40 split:

- **Browser:** `https://edgebot-txline.vercel.app` (dashboard, already loaded).
- **Terminal A:** repository at `/Users/mac/edgebot-txline`.
- **Browser tab B:** the public Solana Explorer link for the live deposit:
  `https://explorer.solana.com/tx/4qfLpfiXnZ8vUo7BbpLkTR2BjXGryoAS1Hx7XbFQc9WDg5YGbrckfN7UM3GpNXFnSpDudCVNyKaFBrxf1eTBRSCc?cluster=devnet`

Do not open or type a credential path, secret key, `.env`, or wallet JSON on
camera. The only live evidence you need is already sanitized in
`evidence/live-daemon-proof-2026-07-19.json`.

Prepare these commands in separate terminal tabs. Run them during the take,
except the Docker command (use the recorded output if the build is slow):

```bash
npm run daemon:replay
```

```bash
npm run judge:verify
```

```bash
docker compose run --rm verify
```

Set the terminal font to 16–18px, hide unrelated tabs, and use a pointer or
highlight box. Do one silent rehearsal to keep every cut under its timecode.

## The timed take

### 00:00–00:20 — Cold open: the claim

**Picture:** Full-screen dashboard. Cursor rests on the market/fair-price area.

**Say:**

> “Sports odds move continuously, but most autonomous demos still trade in
> rounds—and ask you to trust the winner. EdgeBot closes both gaps. Every TxLINE
> odds tick becomes a fresh on-chain price decision, and settlement is derived
> from TxLINE’s proof, not from a winner I type.”

**On-screen lower third:** `TxLINE SSE → policy gate → Solana → proof-settle`.

### 00:20–00:45 — Establish the product

**Picture:** Slow 2–3 second dashboard pan: fixture, fair probability, market
price, exposure/decision area. Do not narrate individual UI labels.

**Say:**

> “The strategy is intentionally legible: TxLINE’s demargined 1X2 home
> probability is the fair YES price; the draw stays in NO. EdgeBot compares it
> with the pool-implied YES price, sizes with quarter-Kelly, and caps both each
> order and aggregate exposure.”

**Cut cue:** At 00:43, move to Terminal A before speaking the word “tick.”

### 00:45–01:25 — Show per-tick autonomy

**Picture:** Terminal A, run `npm run daemon:replay`. Keep the command and all
four tick lines visible. Zoom enough that `ALLOW`, `DENY`, `fair`, `market YES`,
and `exposure` are readable.

**Say over the output:**

> “This is the same daemon in a deterministic TxLINE-format replay. Four unique
> odds events arrive. Four times, it reads the current market, recomputes the
> edge, sizes the position, and crosses the policy seam. Tick two is denied at
> a two-point edge. The other three are allowed. There is no round timer and no
> button press between these decisions.”

**Emphasize with cursor:** `repriced 4 unique odds ticks` → `3 allowed/executed` →
`1 denied`.

### 01:25–01:55 — Make risk auditable

**Picture:** Show the final line pointing to the ledger path, then run:

```bash
jq -c '{decision,reasons,executed,executionId,hash,previous:.sequencePreviousHash}' /tmp/edgebot-replay-gate-ledger-*.jsonl
```

If the glob is unavailable, use the ledger path printed by the daemon.

**Say:**

> “The gate does not silently drop a decision. Every allow and deny is an
> append-only record with reasons, intent, execution status, and a SHA-256 link
> to the previous record. Restarting reconstructs exposure and previously seen
> ticks. A tampered ledger fails closed.”

### 01:55–02:40 — The live transaction proof

**Picture:** Open `evidence/live-daemon-proof-2026-07-19.json` in the editor,
then cut to the Explorer transaction tab. Keep the JSON focused on `rawEvent`,
`gateLedger`, and `receipt`; never show paths or secrets.

**Say:**

> “This is a captured live run, not synthetic narration. TxLINE SSE event
> `1784469300000:10194` reported 31.046 percent for Spain. The daemon read a
> fresh devnet market at 25 percent YES: a 6.046-point edge. The earlier live
> tick at 33.333 percent was denied at 2.335 points. With the unchanged policy,
> this tick was allowed and quarter-Kelly submitted 20.153333 test USDC.”

**Picture:** Switch to Explorer; highlight transaction success, program, and
market/trader accounts.

**Say:**

> “The receipt commits the event ID and tick fingerprint to the policy-ledger
> hash, and that hash commits to this public Solana transaction. The operator’s
> liquidity is disclosed counterparty price—not a model signal.”

### 02:40–03:35 — Prove settlement is not caller-chosen

**Picture:** Terminal A, run `npm run judge:verify`. Keep the final check block
on screen. If network output is slow, cut to the pre-recorded final output at
the same point; do not narrate unseen results.

**Say:**

> “Now the judge path: no wallet, no keypair, no TxLINE credential. It reads the
> settled public market, fetches the real TxLINE final score, derives YES or NO
> from the two goal stats, and compares that derivation with the on-chain
> resolution. It also reproduces the CLV study, replays the four ticks, verifies
> the gate chain, fingerprints the captured live event, fetches the live
> transaction, checks its accounts, and checks the resulting pools.”

**Cursor choreography:** briefly point to `DERIVED outcome = on-chain resolution`,
`captured LIVE TxLINE SSE tick fingerprints`, `live daemon devnet transaction
succeeded`, and finally `ALL CHECKS PASS — 14 passed, 0 failed`.

### 03:35–04:00 — Close with the deployable idea

**Picture:** Return to dashboard, then a final clean shot of the architecture
diagram in `SUBMISSION_TECHNICAL_DOCUMENTATION.md`.

**Say:**

> “EdgeBot is a Sharp Movement Detector evolved into an autonomous value trader:
> live ticks, deterministic math, a visible policy control plane, real devnet
> execution, and proof-derived settlement. The one-command container reproduces
> the judge path. The system is inspectable end to end—signal, decision,
> transaction, and outcome.”

**Final slate (last 2 seconds):**

```text
EdgeBot
TxLINE SSE → auditable gate → Solana execution → trustless proof-settle
Repository · dashboard · SUBMISSION_TECHNICAL_DOCUMENTATION.md
```

## Performance and editorial notes

- Speak at roughly 125–135 words per minute; the quoted narration is deliberately
  compact enough for the four-minute ceiling.
- Use hard cuts at 00:20, 00:45, 01:25, 01:55, 02:40, and 03:35. Avoid animated
  transitions; the system’s evidence is the visual effect.
- Let the two DENY/ALLOW moments breathe for at least 1.5 seconds. They prove
  autonomy and policy integrity better than another dashboard close-up.
- If the dashboard is unavailable, replace 00:20–00:45 with the README’s signal
  table and keep the rest unchanged. Never replace the public verifier with a
  claim that a check passed.
- If the Docker build exceeds the edit window, show the already completed replay
  output and say “the same path is containerized as `docker compose run --rm
  verify`”; the terminal verifier remains the live centerpiece.
- Export at 1080p, 30fps, with terminal text large enough to read on a phone.
