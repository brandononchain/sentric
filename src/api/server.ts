import express, { Request, Response } from "express";
import cors from "cors";
import { config, validateConfig } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { ScoringEngine } from "../scoring/engine";
import { IngestionEngine } from "../ingestion/engine";
import { x402PaymentGate, devModeBypass } from "./x402";
import { SignalQuery, ConsensusQuery } from "../types";

export function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(devModeBypass());

  // Initialize core components
  const kolStore = new KolStore();
  const signalStore = new SignalStore();
  const scoringEngine = new ScoringEngine(signalStore);
  const ingestionEngine = new IngestionEngine(
    kolStore,
    scoringEngine,
    signalStore
  );

  // =========================================
  // Health / Info (free, no payment)
  // =========================================

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "SENTRY Protocol",
      version: "0.1.0",
      description:
        "Agent-native KOL signal intelligence on Solana via x402 micropayments",
      endpoints: {
        signals: "GET /v1/signals (x402 gated, $0.001 USDC)",
        consensus: "GET /v1/signals/consensus (x402 gated, $0.005 USDC)",
        kols: "GET /v1/kols (free)",
        health: "GET /health (free)",
      },
      stats: {
        kolsTracked: kolStore.size(),
        signalsInMemory: signalStore.size(),
        uptime: process.uptime(),
      },
      x402: {
        protocol: "https://solana.com/x402",
        asset: "USDC",
        network: "solana:mainnet-beta",
        facilitator: "Coinbase x402",
      },
    });
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      kolsTracked: kolStore.size(),
      signalsInMemory: signalStore.size(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // =========================================
  // KOL Info (free tier)
  // =========================================

  app.get("/v1/kols", (_req: Request, res: Response) => {
    const kols = kolStore.getAll().map((k) => ({
      address: k.address,
      label: k.label,
      tier: k.tier,
      winRate: Math.round(k.historicalWinRate * 100),
      rugAvoidance: Math.round(k.rugAvoidanceRate * 100),
      totalTrades: k.totalTrackedTrades,
    }));
    res.json({ kols, count: kols.length });
  });

  app.get("/v1/kols/:address", (req: Request, res: Response) => {
    const kol = kolStore.get(req.params.address as string);
    if (!kol) {
      res.status(404).json({ error: "kol_not_found" });
      return;
    }
    res.json({
      address: kol.address,
      label: kol.label,
      tier: kol.tier,
      winRate: Math.round(kol.historicalWinRate * 100),
      avgHoldHours: Math.round(kol.avgHoldDurationMs / 3_600_000),
      rugAvoidance: Math.round(kol.rugAvoidanceRate * 100),
      totalTrades: kol.totalTrackedTrades,
    });
  });

  // =========================================
  // Signals (x402 gated — $0.001 per request)
  // =========================================

  app.get(
    "/v1/signals",
    x402PaymentGate({ priceUsdc: config.signalPriceUsdc }),
    (req: Request, res: Response) => {
      const query: SignalQuery = {
        minConviction: req.query.minConviction
          ? parseInt(req.query.minConviction as string)
          : undefined,
        tokenFilter: req.query.tokenFilter
          ? (req.query.tokenFilter as string).split(",")
          : undefined,
        maxAge: req.query.maxAge
          ? parseInt(req.query.maxAge as string)
          : undefined,
        kolFilter: req.query.kolFilter
          ? (req.query.kolFilter as string).split(",")
          : undefined,
        action: req.query.action as "BUY" | "SELL" | undefined,
        limit: req.query.limit
          ? parseInt(req.query.limit as string)
          : 50,
      };

      const signals = signalStore.query(query);

      res.json({
        signals: signals.map(sanitizeSignal),
        count: signals.length,
        query,
        payment: (req as any).x402,
      });
    }
  );

  // =========================================
  // Consensus (x402 gated — $0.005 per request)
  // =========================================

  app.get(
    "/v1/signals/consensus",
    x402PaymentGate({ priceUsdc: config.consensusPriceUsdc }),
    (req: Request, res: Response) => {
      const query: ConsensusQuery = {
        minKols: req.query.minKols
          ? parseInt(req.query.minKols as string)
          : 2,
        window: req.query.window
          ? parseInt(req.query.window as string)
          : 300,
        minConviction: req.query.minConviction
          ? parseInt(req.query.minConviction as string)
          : undefined,
        limit: req.query.limit
          ? parseInt(req.query.limit as string)
          : 20,
      };

      const consensus = signalStore.getConsensus(query);

      res.json({
        consensus,
        count: consensus.length,
        query,
        payment: (req as any).x402,
      });
    }
  );

  // =========================================
  // Signal Stats (free — for dashboard/monitoring)
  // =========================================

  app.get("/v1/stats", (_req: Request, res: Response) => {
    // Aggregate stats without exposing actual signals
    const allRecent = signalStore.query({ maxAge: 300, limit: 1000 });
    const buys = allRecent.filter((s) => s.action === "BUY").length;
    const sells = allRecent.filter((s) => s.action === "SELL").length;
    const avgConviction =
      allRecent.length > 0
        ? Math.round(
            allRecent.reduce((s, sig) => s + sig.conviction, 0) /
              allRecent.length
          )
        : 0;

    // Unique tokens in recent signals
    const uniqueTokens = new Set(allRecent.map((s) => s.tokenMint)).size;

    // Unique KOLs active
    const activeKols = new Set(allRecent.map((s) => s.kol.address)).size;

    res.json({
      window: "5m",
      signalCount: allRecent.length,
      buys,
      sells,
      avgConviction,
      uniqueTokens,
      activeKols,
      totalKolsTracked: kolStore.size(),
    });
  });

  // =========================================
  // Start ingestion when server starts
  // =========================================

  const server = app.listen(config.port, config.host, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   SENTRY Protocol v0.1.0                          ║
║   Agent-Native KOL Signal Intelligence            ║
║                                                   ║
║   Server:  http://${config.host}:${config.port}              ║
║   KOLs:    ${kolStore.size()} wallets tracked                 ║
║   Payment: x402 / USDC on Solana                  ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
    `);

    // Validate config and start ingestion
    const errors = validateConfig();
    if (errors.length > 0) {
      console.warn("[WARN] Config issues (running in demo mode):");
      errors.forEach((e) => console.warn(`  - ${e}`));
      console.warn(
        "[WARN] Set SENTRY_DEV_MODE=true to bypass x402 payments\n"
      );
    }

    // Start ingestion if Helius key is available
    if (config.heliusApiKey) {
      ingestionEngine.start().catch((err) => {
        console.error("[FATAL] Ingestion engine failed to start:", err);
      });
    } else {
      console.log(
        "[INFO] No HELIUS_API_KEY — ingestion disabled. Signals can be submitted via POST /v1/signals/submit\n"
      );
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[SHUTDOWN] Received SIGTERM");
    ingestionEngine.stop();
    signalStore.destroy();
    server.close();
  });

  process.on("SIGINT", () => {
    console.log("[SHUTDOWN] Received SIGINT");
    ingestionEngine.stop();
    signalStore.destroy();
    server.close();
    process.exit(0);
  });

  return { app, server, kolStore, signalStore, scoringEngine, ingestionEngine };
}

// Sanitize signal for API response (strip internal data)
function sanitizeSignal(signal: any) {
  return {
    id: signal.id,
    kol: {
      label: signal.kol.label,
      address: signal.kol.address,
      tier: signal.kol.tier,
    },
    action: signal.action,
    token: signal.token,
    tokenMint: signal.tokenMint,
    quoteMint: signal.quoteMint,
    conviction: signal.conviction,
    breakdown: signal.breakdown,
    consensusKols: signal.consensusKols,
    timestamp: signal.timestamp,
    signature: signal.swap?.signature,
  };
}
