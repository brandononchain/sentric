# SENTRY Protocol

**Agent-native KOL signal intelligence on Solana via x402 micropayments.**

Solana Frontier Hackathon 2026 submission.

## What is SENTRY?

SENTRY is an autonomous agent that watches 500+ KOL wallets on Solana, scores their conviction in real-time using on-chain behavior, and exposes verified signals as x402-gated API endpoints. It's the first agent-to-agent signal marketplace.

Every existing KOL tracking tool (Kolscan, KolClaw, SCREENER, XHuntr, Cielo) builds dashboards for humans. SENTRY builds for agents. The Solana Foundation says 95-99% of future on-chain transactions will come from AI agents. SENTRY serves them.

## How it works

1. **Ingest** — Subscribes to KOL wallets via Helius WebSocket/API. Captures every swap on Jupiter, Raydium, Meteora, Orca within 400ms of block confirmation.

2. **Score** — 5-factor conviction engine: position size (40%), hold history (20%), historical PnL (15%), rug avoidance (15%), multi-KOL consensus (10%). Output: 0-100 conviction score.

3. **Serve** — Scored signals exposed via x402-gated HTTP endpoints. Any agent pays $0.001 USDC per signal. No API keys. No subscriptions. No accounts.

## Quick Start

```bash
git clone https://github.com/brandononchain/sentry-protocol
cd sentry-protocol
npm install
cp .env.example .env
# Edit .env with your Helius API key

npm run build
npm run dev
```

## API

```
GET /                          — Protocol info (free)
GET /health                    — Health check (free)
GET /v1/kols                   — KOL list (free)
GET /v1/kols/:address          — KOL profile (free)
GET /v1/signals                — Scored signals (x402, $0.001 USDC)
GET /v1/signals/consensus      — Multi-KOL convergence (x402, $0.005 USDC)
GET /v1/stats                  — Aggregate stats (free)
```

### x402 Payment Flow

Requests to paid endpoints without payment return `402 Payment Required` with payment terms:

```json
{
  "error": "payment_required",
  "terms": {
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000",
    "recipient": "TREASURY_WALLET",
    "network": "solana:mainnet-beta",
    "protocol": "x402"
  }
}
```

Include a signed payment in the `x-payment` header to access the data.

### Signal Response

```json
{
  "signals": [
    {
      "kol": { "label": "@ansem", "tier": "s" },
      "action": "BUY",
      "token": "POPCAT",
      "tokenMint": "7GCihgDB8...",
      "conviction": 94,
      "breakdown": {
        "positionSizeScore": 90,
        "holdHistoryScore": 70,
        "historicalPnlScore": 95,
        "rugAvoidanceScore": 100,
        "consensusScore": 75
      },
      "consensusKols": ["@hsaka", "@blknoiz06"],
      "timestamp": 1715100000000
    }
  ]
}
```

## Stack

- **Runtime:** Node.js / TypeScript
- **Data:** Helius Enhanced API + WebSocket
- **Parsing:** Jupiter v6, Raydium CLMM, Meteora DLMM, Orca Whirlpool
- **Scoring:** In-memory 5-factor conviction engine
- **Payment:** x402 protocol / USDC on Solana / Coinbase facilitator
- **Distribution:** REST API, WebSocket, Solana Agent Kit plugin (coming)

## Environment Variables

See `.env.example` for all configuration options. The only required key for live operation is `HELIUS_API_KEY`.

Set `SENTRY_DEV_MODE=true` to bypass x402 payment verification during development.

## License

MIT
