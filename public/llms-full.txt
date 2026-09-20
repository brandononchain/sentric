# Sentric

**Open-source Solana wallet intelligence for AI agents.**

Sentric watches a configurable Solana wallet list and exposes scored swaps, same-direction consensus, and optional social context through REST and MCP. It is a research data service: it does not custody funds, execute trades, or require an LLM provider.

[Website](https://sentric.sh) · [Integration guide](public/docs/index.html) · [OpenAPI](public/openapi.json) · [LLM reference](public/llms-full.txt) · [MIT license](LICENSE)

## Run locally

Requires Node.js **22.12 or newer**.

```sh
git clone https://github.com/brandononchain/sentric.git
cd sentric
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:3000 for the branded site and `/docs/` for documentation. The example configuration enables development payment bypass. Without a Helius key, the service returns an explicit `unconfigured` state and empty signal arrays; it does not generate fake activity.

```sh
curl http://127.0.0.1:3000/health
curl 'http://127.0.0.1:3000/v1/signals?action=BUY&minConviction=60&limit=10'
node examples/research-agent.mjs
npm test
```

## Connect an agent

The repository includes a working read-only MCP server and a TypeScript HTTP client. After `npm run build`, add this configuration to your MCP-compatible application:

```json
{
  "mcpServers": {
    "sentric": {
      "command": "node",
      "args": ["/absolute/path/to/sentric/dist/agent/mcp.js"],
      "env": { "SENTRIC_API_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

Tools: `sentric_status`, `sentric_wallets`, `sentric_preview`, `sentric_signals`, `sentric_consensus`. The stdio process keeps protocol output clean. It never holds wallet keys or automatically signs payments. Preview/status/wallet tools work against production; full signal/consensus tools work against a local development API and return structured payment errors against a paid API.

For paid integrations, inject an x402-enabled `fetch` into `SentricClient` from `src/agent/client.ts`. Set per-request and total spending limits in the calling agent. There is no published `@sentric/agent-kit` package.

## Live ingestion

Set `HELIUS_API_KEY`; optionally set `HELIUS_WS_URL` to an Enhanced WebSocket URL supported by your Helius plan. Polling runs in batches, waits for completion, then waits ten seconds. WebSocket transaction signatures are hydrated through Helius Enhanced Transactions before parsing. Polling is a fallback, not a guaranteed complete archive; high-volume wallets can exceed the 20-transaction polling window. Provider plans and rate limits affect freshness and cost. No latency guarantee is made.

Set `JUPITER_API_KEY` for Jupiter Price API v3. Token amounts retain their decimals. Missing prices score neutrally instead of being treated as zero-value trades or rugs. Stablecoin quote valuation assumes nominal $1 and does not detect depegs.

`BACKFILL_ON_START=true` loads only recent signals inside the configured retention window. `AUTO_DISCOVERY=true` enables experimental provider-based discovery and requires `ADMIN_API_KEY`. Both are opt-in because they consume provider requests.

## API

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Free | Process health, ingestion freshness, payments and social state |
| `GET /v1` | Free | API discovery |
| `GET /v1/kols`, `/v1/kols/count`, `/v1/kols/:address` | Free | Operator-supplied watchlist |
| `GET /v1/stats` | Free | Five-minute aggregates |
| `GET /v1/signals/preview` | Free | Up to seven recent signals |
| `GET /v1/signals` | x402 | Filtered signals; default $0.001 USDC |
| `GET /v1/signals/consensus` | x402 | Same-direction, distinct-wallet groups; default $0.005 USDC |
| `GET /v1/signals/social` | x402 | Optional configured social provider; default $0.001 USDC |
| `POST /v1/kols` | Admin bearer token | Add a wallet |
| `POST /v1/kols/discover` | Admin bearer token | Trigger experimental discovery |

Signal filters: `action=BUY|SELL`, `minConviction=0..100`, `maxAge=1..86400` seconds, comma-separated `tokenFilter` / `kolFilter`, and `limit=1..100`. Retention caps available history. Results are newest-first, not highest-score-first. Timestamps are Unix milliseconds.

```sh
curl -X POST http://127.0.0.1:3000/v1/kols \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"address":"YOUR_SOLANA_PUBLIC_KEY","label":"Research wallet","tier":"b"}'
```

Optionally supply `xHandle` only when you have verified the attribution. Seed labels are historical operator-supplied watchlist entries, **not independently verified ownership claims**. No automatic label-to-X identity inference is performed. For existing seed wallets, edit the seed configuration (or persisted wallet file while stopped) to set an explicit verified handle.

## Scoring and data quality

The 0–100 conviction value is a **heuristic, not a profit probability**. Weights: absolute USD trade size 40%, holding history 20%, historical PnL 15%, rug avoidance 15%, same-direction wallet consensus 10%. Historical metrics are unknown by default and contribute neutral scores of 50. Public win rate, rug avoidance and trade-count fields are null rather than seeded guesses. Historical metric computation requires a separate complete accounting pipeline; this release does not claim to provide it.

Only successful, attributable base-asset-to-token or token-to-base swaps are included. Ambiguous multi-asset and token-to-token swaps are excluded. Consensus deduplicates wallet addresses, separates buys and sells, and excludes the current wallet from its own scoring context. Repeated ingestion of the same wallet/transaction is idempotent. No signal should be interpreted without checking freshness, the transaction, token identity, liquidity and your own risk policy.

## x402 configuration

Paid routes use the official `@x402/express`, `@x402/core` and `@x402/svm` v2 packages for verification and settlement. Arbitrary strings in payment headers are never accepted as proof. Configure:

- `SENTRIC_DEV_MODE=false` and `NODE_ENV=production` (production ignores legacy development-bypass flags and keeps paid routes closed).
- `TREASURY_WALLET`: recipient public key; no private key required by this server.
- `X402_FACILITATOR_URL`: an HTTPS facilitator supporting the selected network and exact SVM scheme.
- `X402_FACILITATOR_TOKEN`: optional bearer token for facilitators using static bearer authentication. Providers requiring JWT auth need a provider-specific auth adapter.
- `X402_NETWORK`: devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (default), or mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.

USDC mint/decimals come from the official scheme's network definitions. A configured facilitator is initialized lazily; healthy public routes do not depend on it. Missing/unavailable payment configuration returns **503**, never unpaid access. Valid unpaid requests receive the SDK's **402** terms. Query validation occurs before payment processing. Unconfigured or stale live ingestion returns 503 before requesting payment. An uncertain settlement outcome must be reconciled before retrying; do not blindly resend signed payments.

## Deploy

This repository serves the website **and** API from one Node service, keeping browser requests same-origin. Railway: `npm ci && npm run build`, start `npm start`, health route `/health`, `HOST=0.0.0.0`, and the platform-provided `PORT`. See `railway.json`.

Set `DATA_DIR` to a mounted persistent volume for wallet additions. Without it, additions last only until restart. Signals and social context are intentionally ephemeral; deploy one process/replica. Redis is not implemented. Multi-replica ingestion, shared rate limiting and durable signal history require shared infrastructure before scaling out.

If `sentric.sh` remains on a separate static host, configure that host to proxy `/v1/*` and `/health` to the Node backend, or move the domain to the Node service. Do not deploy just `public/` and expect an API to exist. Trust only the exact reverse-proxy hop count via `TRUST_PROXY_HOPS`.

Before enabling paid mainnet access, test your configured facilitator on devnet with a funded test wallet, including rejection/replay handling. Automated tests use a local mock facilitator and do not spend USDC or prove a live deployment is configured.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Run `npm test` before opening a pull request. CI verifies Node 22 and 24. No secrets, keypairs or `.env` files belong in commits.
