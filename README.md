# SENTRY Protocol

**The Bloomberg Terminal for Solana agents.**

Your agent knows what @ansem just bought before his followers do. One API call returns the highest-conviction KOL trade in the last 60 seconds. $0.001 in USDC. No key, no account.

[Live site](https://sentry-protocol.vercel.app) · [Solana Frontier Hackathon 2026](https://colosseum.com/frontier)

---

## How it works

1. **We watch** — 512 KOL wallets monitored 24/7 via Helius WebSocket. Every swap on Jupiter, Raydium, and Meteora captured in under 400ms.

2. **We score** — Each trade gets a 0–100 conviction score from five on-chain metrics: position size (40%), hold history (20%), historical PnL (15%), rug avoidance (15%), multi-wallet consensus (10%).

3. **Your agent acts** — One API call. The response tells your agent exactly what was bought, by whom, and how confident they are. Your agent decides what to do next.

---

## Quick start

```bash
git clone https://github.com/brandononchain/sentry-protocol
cd sentry-protocol
npm install
cp .env.example .env
```

Edit `.env`:

```env
HELIUS_API_KEY=your_key_here
TREASURY_WALLET=your_solana_wallet_address
SENTRY_DEV_MODE=true
```

Run:

```bash
npm run build
npm run dev
```

The server starts at `http://localhost:3000`. Dev mode bypasses x402 payment verification so you can test every endpoint without USDC.

---

## Running & testing

### Without a Helius key (demo mode)

If you don't set `HELIUS_API_KEY`, the server still starts. Ingestion is disabled — no live wallet monitoring — but all API routes work. The signal store will be empty, so responses return `[]`. Good for testing the API shape and x402 flow.

```bash
# Start without Helius
SENTRY_DEV_MODE=true npm run dev

# Test endpoints
curl http://localhost:3000/              # Protocol info
curl http://localhost:3000/health        # Health check
curl http://localhost:3000/v1/kols       # KOL list (10 seeded wallets)
curl http://localhost:3000/v1/signals    # Signals (empty without ingestion)
curl http://localhost:3000/v1/stats      # Aggregate stats
```

### With a Helius key (live ingestion)

1. Get a free key at [helius.dev](https://helius.dev) (1M credits/month on free tier)
2. Set it in `.env`:

```env
HELIUS_API_KEY=your_helius_key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_helius_key
HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=your_helius_key
```

3. Run `npm run dev`. The ingestion engine connects via WebSocket and starts polling KOL wallets. When a KOL swaps, the signal appears in `/v1/signals` within 400ms.

### Testing x402 payment flow

With `SENTRY_DEV_MODE=true`, all paid endpoints are free. To test the actual 402 flow:

```bash
# Set dev mode OFF
SENTRY_DEV_MODE=false npm run dev

# This returns 402 with payment terms
curl http://localhost:3000/v1/signals

# Response:
# {
#   "error": "payment_required",
#   "terms": {
#     "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
#     "amount": "1000",
#     "recipient": "YOUR_TREASURY_WALLET",
#     "network": "solana:mainnet-beta",
#     "protocol": "x402"
#   }
# }

# Pass any string >10 chars as payment header to bypass (MVP placeholder)
curl -H "x-payment: test-payment-proof-12345" http://localhost:3000/v1/signals
```

In production, the `x-payment` header would contain a signed USDC transfer verified by Coinbase's x402 facilitator.

### Devnet vs Mainnet

The current implementation targets **mainnet** wallet addresses and RPC endpoints. To run on devnet:

1. Change `HELIUS_RPC_URL` to a devnet RPC
2. Replace KOL wallet addresses in `src/config/kols.ts` with devnet wallets you control
3. The USDC mint in config defaults to mainnet USDC — for devnet testing this doesn't matter since `SENTRY_DEV_MODE=true` skips payment verification entirely

For the hackathon demo, run with `SENTRY_DEV_MODE=true` on mainnet to watch real KOL trades without handling real payments.

---

## API

### Free endpoints

```
GET /                    Protocol info, version, stats
GET /health              Health check, uptime, signal count
GET /v1/kols             All tracked KOL wallets
GET /v1/kols/:address    Single KOL profile and stats
GET /v1/stats            Aggregate signal stats (5m window)
```

### Paid endpoints (x402)

```
GET /v1/signals              $0.001 USDC — scored KOL signals
GET /v1/signals/consensus    $0.005 USDC — multi-KOL convergence
```

### Query parameters for `/v1/signals`

| Param | Type | Description |
|-------|------|-------------|
| `minConviction` | int | Minimum conviction score (0–100) |
| `maxAge` | int | Max signal age in seconds |
| `action` | string | `BUY` or `SELL` |
| `tokenFilter` | string | Comma-separated token mints |
| `kolFilter` | string | Comma-separated KOL addresses |
| `limit` | int | Max results (default 50) |

### Signal response

```json
{
  "signals": [
    {
      "id": "sig_abc123",
      "kol": { "label": "@ansem", "address": "7v91...", "tier": "s" },
      "action": "BUY",
      "token": "POPCAT",
      "tokenMint": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
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
  ],
  "count": 1
}
```

### Agent Kit plugin

```typescript
import { SentryPlugin } from "@sentry/agent-kit";

const agent = new SolanaAgentKit(wallet, rpc).use(SentryPlugin);

const signal = await agent.getBestSignal();
if (signal.conviction > 90) {
  await agent.trade(signal.mint, signal.size_sol);
}
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HELIUS_API_KEY` | Yes (for live data) | — | Helius API key for wallet monitoring |
| `HELIUS_RPC_URL` | No | Public RPC | Helius RPC endpoint |
| `HELIUS_WS_URL` | No | — | Helius WebSocket for real-time |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `TREASURY_WALLET` | Yes (for payments) | — | Solana wallet for x402 settlement |
| `USDC_MINT` | No | Mainnet USDC | USDC token mint address |
| `SIGNAL_PRICE_USDC` | No | `0.001` | Price per signal request |
| `CONSENSUS_PRICE_USDC` | No | `0.005` | Price per consensus request |
| `SIGNAL_TTL_SECONDS` | No | `300` | How long signals stay in memory |
| `MAX_SIGNALS` | No | `10000` | Max signals in memory |
| `SENTRY_DEV_MODE` | No | `false` | Bypass x402 payment verification |
| `REDIS_URL` | No | — | Redis URL (falls back to in-memory) |

---

## Stack

- **Runtime:** Node.js / TypeScript / Express
- **Data:** Helius Enhanced API + WebSocket
- **Parsing:** Jupiter v6, Raydium CLMM, Meteora DLMM, Orca Whirlpool
- **Scoring:** In-memory 5-factor conviction engine
- **Payment:** x402 protocol / USDC on Solana
- **Distribution:** REST API + Solana Agent Kit plugin

---

## Project structure

```
src/
├── index.ts                 Entry point
├── config/
│   ├── index.ts             Environment config
│   └── kols.ts              KOL wallet database
├── ingestion/
│   ├── engine.ts            Helius WebSocket + polling
│   └── parser.ts            Transaction parser (Jupiter, Raydium, etc.)
├── scoring/
│   └── engine.ts            5-factor conviction scoring
├── store/
│   └── signal-store.ts      In-memory signal store with TTL
└── api/
    ├── server.ts            Express routes
    └── x402.ts              x402 payment middleware
public/
├── index.html               Landing page
├── sitemap.xml              XML sitemap
└── robots.txt               Crawler rules
```

---

## License

MIT

## Author

[@brandononchain](https://x.com/brandononchain)
