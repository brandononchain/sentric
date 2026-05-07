import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Helius
  heliusApiKey: process.env.HELIUS_API_KEY || "",
  heliusRpcUrl: process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com",
  heliusWsUrl: process.env.HELIUS_WS_URL || "",

  // Server
  port: parseInt(process.env.PORT || "3000"),
  host: process.env.HOST || "0.0.0.0",

  // Redis (optional — falls back to in-memory)
  redisUrl: process.env.REDIS_URL || "",

  // x402 / Payment
  treasuryWallet: process.env.TREASURY_WALLET || "",
  usdcMint: process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet USDC
  signalPriceUsdc: parseFloat(process.env.SIGNAL_PRICE_USDC || "0.001"),
  consensusPriceUsdc: parseFloat(process.env.CONSENSUS_PRICE_USDC || "0.005"),

  // Signal
  signalTtlSeconds: parseInt(process.env.SIGNAL_TTL_SECONDS || "300"), // 5 min default
  maxSignalsInMemory: parseInt(process.env.MAX_SIGNALS || "10000"),

  // Scoring weights
  scoring: {
    positionSizeWeight: 0.40,
    holdHistoryWeight: 0.20,
    historicalPnlWeight: 0.15,
    rugAvoidanceWeight: 0.15,
    consensusWeight: 0.10,
  },

  // Well-known mints (used to classify BUY vs SELL)
  stableAndBaseMints: new Set([
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "So11111111111111111111111111111111111111112",      // wSOL
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",   // mSOL
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",   // JupSOL
    "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  ]),
};

// Validate critical config
export function validateConfig(): string[] {
  const errors: string[] = [];
  if (!config.heliusApiKey) errors.push("HELIUS_API_KEY is required");
  if (!config.treasuryWallet) errors.push("TREASURY_WALLET is required for x402 payments");
  return errors;
}
