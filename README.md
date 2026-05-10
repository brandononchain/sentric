# Sentric.sh

**The Bloomberg Terminal for Solana agents.**

Your agent knows what @ansem just bought before his followers do. One API call returns the highest-conviction KOL trade in the last 60 seconds. $0.001 in USDC. No key, no account.

[sentric.sh](https://sentric.sh) · [Solana Frontier Hackathon 2026](https://colosseum.com/frontier)

---

## How it works

1. **We watch** — 58+ KOL wallets monitored 24/7 via Helius WebSocket (auto-expanding via the sourcing pipeline). Every swap on Jupiter, Raydium, and Meteora captured in under 400ms.

2. **We score** — Each trade gets a 0–100 conviction score from five on-chain metrics: position size (40%), hold history (20%), historical PnL (15%), rug avoidance (15%), multi-wallet consensus (10%).

3. **Your agent acts** — One API call. The response tells your agent exactly what was bought, by whom, and how confident they are. Your agent decides what to do next.

---

## Quick start

```bash
git clone https://github.com/brandononchain/sentric
cd sentric
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

If you don't set `HELIUS_API_KEY`, the server still starts. Ingestion and auto-sourcing are disabled — no live wallet monitoring — but all API routes work. The signal store will be empty, so responses return `[]`. Good for testing the API shape and x402 flow.

```bash
# Start without Helius
SENTRY_DEV_MODE=true npm run dev

# Test endpoints
curl http://localhost:3000/              # Protocol info
curl http://localhost:3000/health        # Health check
curl http://localhost:3000/v1/kols       # KOL list (58 seeded wallets)
curl http://localhost:3000/v1/kols/count # Live KOL count
curl http://localhost:3000/v1/signals    # Signals (empty without ingestion)
curl http://localhost:3000/v1/stats      # Aggregate stats
```

### With a Helius key (live ingestion + auto-sourcing)

1. Get a free key at [helius.dev](https://helius.dev) (1M credits/month on free tier)
2. Set it in `.env`:

```env
HELIUS_API_KEY=your_helius_key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_helius_key
HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=your_helius_key
```

3. Run `npm run dev`. The ingestion engine connects via WebSocket and starts polling KOL wallets. The auto-sourcer runs immediately on startup, then every 6 hours. When a KOL swaps, the signal appears in `/v1/signals` within 400ms.

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

---

## API

### Free endpoints

```
GET  /                       Protocol info, version, stats
GET  /health                 Health check, uptime, signal count
GET  /v1/kols                All tracked KOL wallets
GET  /v1/kols/count          Live KOL count (used by landing page)
GET  /v1/kols/:address       Single KOL profile and stats
GET  /v1/stats               Aggregate signal stats (5m window)
POST /v1/kols                Add a new KOL wallet dynamically
POST /v1/kols/discover       Trigger auto-sourcing cycle manually
```

### Paid endpoints (x402)

```
GET /v1/signals              $0.001 USDC — scored KOL signals
GET /v1/signals/consensus    $0.005 USDC — multi-KOL convergence
```

### Adding KOL wallets

```bash
curl -X POST https://your-api-url/v1/kols \
  -H "Content-Type: application/json" \
  -d '{
    "address": "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm",
    "label": "@ansem",
    "tier": "s",
    "winRate": 0.72,
    "holdHours": 4,
    "rugAvoidance": 0.94
  }'
```

Returns `201` with the new total count. Rejects duplicates with `409`. The ingestion engine auto-subscribes new wallets to Helius monitoring.

### Triggering auto-discovery

```bash
curl -X POST https://your-api-url/v1/kols/discover
```

Returns:
```json
{
  "discovered": 47,
  "added": 12,
  "skipped": 33,
  "errors": 2,
  "totalBefore": 58,
  "totalAfter": 70
}
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
      "kol": { "label": "@ansem", "address": "AVAZv...", "tier": "s" },
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
      "consensusKols": ["@theo", "@Letterbomb"],
      "timestamp": 1715100000000
    }
  ],
  "count": 1
}
```

### Agent Kit plugin

```typescript
import { SentricPlugin } from "@sentric/agent-kit";

const agent = new SolanaAgentKit(wallet, rpc).use(SentricPlugin);

const signal = await agent.getBestSignal();
if (signal.conviction > 90) {
  await agent.trade(signal.mint, signal.size_sol);
}
```

---

## Auto-sourcing pipeline

When the server starts with a Helius key, the auto-sourcer discovers new KOL wallets automatically:

**Schedule:** Runs immediately on startup, then every 6 hours.

**Source 1 — Helius Jupiter scanner:** Pulls the last 100 Jupiter v6 swap transactions and identifies wallets that appear 3+ times. High-frequency DEX traders get added as B-tier KOLs.

**Source 2 — Consensus detector:** Checks what tokens the top S/A-tier KOLs are trading, then finds other wallets trading the same tokens in the same window. If @ansem and @theo are both buying POPCAT and wallet `XYZ` is also buying it, `XYZ` is likely another KOL or smart money.

**Qualification filter:** Minimum 3 trades, not a known bot/program address, not already tracked. All auto-discovered wallets start at B-tier.

**Landing page integration:** The KOL count on the landing page fetches `GET /v1/kols/count` every 30 seconds, so the number updates live as wallets are added.

---

## KOL database

58 wallets seeded from verified sources:

- **Kolscan.io daily leaderboard** — top 50 ranked by daily SOL PnL (scraped May 2026)
- **Kolscan live trade feed** — active traders verified in real-time
- **Datawallet** — Ansem wallet address confirmation
- **PANews / Arkham** — Toly-linked wallet addresses

8 S-tier, 19 A-tier, 29 B-tier, 2 notable ecosystem wallets.

All addresses verified as active on Solana mainnet via Solscan.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HELIUS_API_KEY` | Yes (for live data) | — | Helius API key for wallet monitoring + auto-sourcing |
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
- **Sourcing:** Automated KOL discovery via Helius + consensus detection
- **Distribution:** REST API + Solana Agent Kit plugin

---

## Project structure

```
src/
├── index.ts                 Entry point
├── config/
│   ├── index.ts             Environment config
│   └── kols.ts              KOL wallet database (58 seeded)
├── ingestion/
│   ├── engine.ts            Helius WebSocket + polling
│   └── parser.ts            Transaction parser (Jupiter, Raydium, etc.)
├── scoring/
│   └── engine.ts            5-factor conviction scoring
├── sourcing/
│   └── auto-sourcer.ts      Automated KOL discovery pipeline
├── store/
│   └── signal-store.ts      In-memory signal store with TTL
└── api/
    ├── server.ts            Express routes + auto-sourcer integration
    └── x402.ts              x402 payment middleware
public/
├── index.html               Landing page (live KOL count from API)
├── sitemap.xml              XML sitemap
└── robots.txt               Crawler rules
```

---

## Deployment

**Landing page:** Deployed on Vercel at [sentric.vercel.app](https://sentric.vercel.app)

**Backend API:** Deployed on Railway at `sentric-production.up.railway.app`

The landing page fetches the live KOL count from the Railway API every 30 seconds.

---

## License

MIT

## Author

[@brandononchain](https://x.com/brandononchain)
