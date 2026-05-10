import express, { Request, Response } from "express";
import cors from "cors";
import { config, validateConfig } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { ScoringEngine } from "../scoring/engine";
import { IngestionEngine } from "../ingestion/engine";
import { KolAutoSourcer } from "../sourcing/auto-sourcer";
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
      name: "Sentric",
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

  // KOL count — lightweight endpoint for landing page (must be before :address)
  app.get("/v1/kols/count", (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ count: kolStore.size() });
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
  // Add KOL wallets dynamically (POST)
  // =========================================

  app.post("/v1/kols", (req: Request, res: Response) => {
    const { address, label, tier, winRate, holdHours, rugAvoidance } = req.body;

    if (!address || typeof address !== "string" || address.length < 32) {
      res.status(400).json({ error: "invalid_address", message: "Solana address required (32+ chars)" });
      return;
    }

    if (kolStore.has(address)) {
      res.status(409).json({ error: "already_tracked", message: "This wallet is already being tracked" });
      return;
    }

    const newKol = {
      address,
      label: label || address.slice(0, 6),
      tier: (tier === "s" || tier === "a" || tier === "b") ? tier : "b" as const,
      historicalWinRate: typeof winRate === "number" ? winRate : 0.5,
      avgHoldDurationMs: (typeof holdHours === "number" ? holdHours : 2) * 3600000,
      rugAvoidanceRate: typeof rugAvoidance === "number" ? rugAvoidance : 0.8,
      totalTrackedTrades: 0,
      addedAt: Date.now(),
    };

    kolStore.add(newKol);

    // If ingestion engine is running, subscribe to the new wallet
    if (config.heliusApiKey) {
      ingestionEngine.addWallet(address).catch(() => {});
    }

    res.status(201).json({
      added: true,
      kol: {
        address: newKol.address,
        label: newKol.label,
        tier: newKol.tier,
      },
      totalKols: kolStore.size(),
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
  // Manual KOL discovery trigger
  // =========================================

  const autoSourcer = new KolAutoSourcer(kolStore, `http://localhost:${config.port}`);

  app.post("/v1/kols/discover", async (_req: Request, res: Response) => {
    if (!config.heliusApiKey) {
      res.status(503).json({ error: "no_helius_key", message: "Auto-sourcing requires HELIUS_API_KEY" });
      return;
    }

    const before = kolStore.size();
    const results = await autoSourcer.runOnce();
    const after = kolStore.size();

    res.json({
      discovered: results.added + results.skipped + results.errors,
      added: results.added,
      skipped: results.skipped,
      errors: results.errors,
      totalBefore: before,
      totalAfter: after,
    });
  });

  // =========================================
  // Start ingestion when server starts
  // =========================================

  const server = app.listen(config.port, config.host, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   Sentric v0.1.0                          ║
║   The Bloomberg Terminal for Solana Agents            ║
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

      // Start auto-sourcing KOL wallets (every 6 hours)
      autoSourcer.start(6 * 60 * 60 * 1000);
    } else {
      console.log(
        "[INFO] No HELIUS_API_KEY — ingestion and auto-sourcing disabled.\n"
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
