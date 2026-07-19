# EdgeBot — 3-Minute Product Demo (the simple, honest one)

This is a **product** demo, not a trading brag: show the operator's workflow — a
provably-fair sports market that prices from TxLINE, settles itself from proof, and
that anyone can audit. One take, no editing, no AI video. Fumbles are fine — keep going.

## Setup (5 min, nothing to install)
- Screen-record with `⌘⇧5` → "Record Entire Screen" → Record. (Or Loom, free.)
- Open two things only: the dashboard `https://edgebot-txline.vercel.app` in a browser,
  and a terminal in `/Users/mac/edgebot-txline`.
- Do **not** show a keypair, `.env`, secret, or wallet file on camera.
- One silent rehearsal so the commands are muscle memory. That's it.

> Talking is optional. If narrating is stressful, record it silent doing the clicks —
> the terminal output carries it — and add a one-line caption per beat. A shaky voice
> is completely fine; judges do not care about polish.

---

## The take (~3:00, one continuous take)

### 0:00 – 0:20 · The problem
**Show:** the dashboard, resting.
> "On-chain sports betting has one hard problem: who decides who won — and why should
> anyone trust them? Most markets need an admin or an oracle you have to trust. EdgeBot
> is a tool that removes the trusted party. Here's how an operator would use it."

### 0:20 – 0:50 · The product: a live, TxLINE-priced market
**Show:** slowly scroll the dashboard — the market, the pools, the position.
> "This is a real match-outcome market on Solana devnet, powered by TxLINE. An operator
> opens a market on a fixture; EdgeBot prices it and provides two-sided liquidity straight
> from TxLINE's live sharp odds, so bettors always have a fair counterparty. Everything
> here — pools, position, settlement — is real on-chain state, not a mockup."

### 0:50 – 1:30 · Autonomous pricing from the live feed
**Show:** terminal — run `npm run daemon:replay`. Let the four tick lines print.
> "The pricing is autonomous and tied to the feed. This replays real TxLINE odds ticks:
> on each tick it re-reads the market, re-prices, and a policy gate decides — allow or
> deny. No human in the loop, and every decision is written to a tamper-evident ledger."

**Point at:** the `ALLOW` lines and the one `DENY`. Let it breathe ~2 seconds.

### 1:30 – 2:15 · The payoff: settlement nobody can fake
**Show:** back to the dashboard — the settled position (Settlement · YES · Argentina 3–2).
> "Here's the part that matters. When the match ends, the market doesn't wait for an admin
> to call it. It settles automatically from TxLINE's cryptographic proof of the real score —
> the winner is derived on-chain, from the proof. Nobody, not even the operator, can pick
> the outcome. This one settled YES because the real result was Argentina three–two."

### 2:15 – 2:50 · Anyone can audit it
**Show:** terminal — run `npm run judge:verify`. Then click an Explorer link.
> "And you don't have to trust me. This re-checks everything from public devnet and the
> real TxLINE feed — no wallet, no key, no account. It confirms the market settled,
> re-fetches the real score, and proves the on-chain winner matches reality."

**Wait for** `ALL CHECKS PASS`, then cut to Explorer:
> "Every check passes. And it's all public on Solana — here's the market and the settlement
> transaction."

### 2:50 – 3:00 · Close
**Show:** the dashboard.
> "That's EdgeBot: provably-fair sports markets an operator or desk can run — liquidity and
> settlement powered by TxLINE, and an audit anyone can run. Thanks for watching."

Stop recording. Done.

---

## Notes
- **Honesty is built in.** This demo makes no edge or profit claim — the product is the
  provable settlement and the liquidity, which are real. That's why it's stronger than a
  trading brag: nothing here is contradicted by the repo.
- One honest caveat you can say if you like: *"this is a devnet reference implementation."*
- Export 1080p; terminal font 16–18px so it's readable on a phone.
- A more detailed 4-minute cut lives in `DEMO_SCRIPT_4_MINUTES.md` if you ever want it —
  but this 3-minute one is enough.
