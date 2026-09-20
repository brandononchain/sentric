import express, { RequestHandler, ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config, validateConfig } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { ScoringEngine } from "../scoring/engine";
import { IngestionEngine } from "../ingestion/engine";
import { KolAutoSourcer } from "../sourcing/auto-sourcer";
import { KolStatsEngine } from "../stats/kol-stats";
import { XMonitor } from "../social/x-monitor";
import { createPaymentGate } from "./x402";
import {
  signalQuery,
  consensusQuery,
  socialQuery,
  walletBody,
} from "./validation";
import { KolProfile, ScoredSignal } from "../types";
import { z } from "zod";

export function createApp() {
  if (config.devMode && process.env.NODE_ENV === "production")
    throw new Error("Development mode cannot run in production");
  const invalid = validateConfig().filter(
    (e) => !e.startsWith("HELIUS_API_KEY") && !e.startsWith("TREASURY_WALLET"),
  );
  if (invalid.length) throw new Error(invalid.join("; "));
  const app = express();
  app.disable("x-powered-by");
  // Set an exact hop count only when deployed behind a known reverse proxy.
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0)
    throw new Error("Invalid TRUST_PROXY_HOPS");
  if (proxyHops) app.set("trust proxy", proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          "font-src": ["'self'", "https://fonts.gstatic.com"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      exposedHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-RESPONSE",
        "X-Sentric-Payment-Mode",
      ],
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use(
    "/v1",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use("/v1", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const kolStore = new KolStore(),
    signalStore = new SignalStore();
  const scoringEngine = new ScoringEngine(signalStore);
  const xMonitor = new XMonitor(kolStore, signalStore);
  const ingestionEngine = new IngestionEngine(
    kolStore,
    scoringEngine,
    signalStore,
  );
  const autoSourcer = new KolAutoSourcer(
    kolStore,
    `http://127.0.0.1:${config.port}`,
  );
  const statsEngine = new KolStatsEngine(kolStore, signalStore, scoringEngine);
  const payment = createPaymentGate();
  const requireLiveData: RequestHandler = (_req, res, next) => {
    const status = ingestionEngine.getStatus();
    if (
      !config.devMode &&
      (!status.enabled || !status.running || status.stale)
    ) {
      res.status(503).json({
        error: "live_data_unavailable",
        message:
          "Live ingestion is unavailable or stale; no payment requested.",
      });
      return;
    }
    next();
  };
  const dataMode = () => (config.heliusApiKey ? "live" : "unconfigured");
  const admin: RequestHandler = (req, res, next) => {
    if (!config.adminApiKey) {
      res.status(503).json({ error: "admin_not_configured" });
      return;
    }
    const supplied = Buffer.from(req.get("Authorization") || ""),
      expected = Buffer.from(`Bearer ${config.adminApiKey}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
  const validate =
    (schema: z.ZodType): RequestHandler =>
    (req, res, next) => {
      const result = schema.safeParse(req.query);
      if (!result.success) {
        res
          .status(400)
          .json({ error: "invalid_query", details: result.error.issues });
        return;
      }
      res.locals.query = result.data;
      next();
    };
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      version: "0.2.0",
      dataMode: dataMode(),
      ingestion: ingestionEngine.getStatus(),
      payments: payment.status(),
      social: xMonitor.getStats(),
      kolsTracked: kolStore.size(),
      signalsInMemory: signalStore.size(),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
  app.get("/v1", (_req, res) =>
    res.json({
      name: "Sentric",
      version: "0.2.0",
      description: "Open-source Solana wallet intelligence for AI agents",
      docs: "/docs/",
      openapi: "/openapi.json",
      payments: payment.status(),
      dataMode: dataMode(),
    }),
  );
  const walletView = (k: KolProfile) => ({
    address: k.address,
    label: k.label,
    tier: k.tier,
    attribution: "operator_supplied",
    metricsSource: k.metricsSource || "unknown",
    winRate: null,
    rugAvoidance: null,
    totalTrades: null,
    xHandle: k.xHandle || null,
  });
  app.get("/v1/kols", (_req, res) =>
    res.json({
      kols: kolStore.getAll().map(walletView),
      count: kolStore.size(),
    }),
  );
  app.get("/v1/kols/count", (_req, res) =>
    res.json({ count: kolStore.size() }),
  );
  app.get("/v1/kols/:address", (req, res) => {
    const kol = kolStore.get(req.params.address as string);
    if (!kol) {
      res.status(404).json({ error: "kol_not_found" });
      return;
    }
    res.json(walletView(kol));
  });
  app.post("/v1/kols", admin, async (req, res) => {
    const parsed = walletBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_wallet", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    if (kolStore.has(data.address)) {
      res.status(409).json({ error: "already_tracked" });
      return;
    }
    const kol: KolProfile = {
      ...data,
      label: data.label || data.address.slice(0, 6),
      historicalWinRate: 0.5,
      avgHoldDurationMs: 0,
      rugAvoidanceRate: 0.5,
      totalTrackedTrades: 0,
      metricsSource: "unknown",
      addedAt: Date.now(),
    };
    kolStore.add(kol);
    await ingestionEngine.addWallet(kol.address);
    if (xMonitor.isEnabled()) xMonitor.addWallet(kol);
    res
      .status(201)
      .json({ added: true, kol: walletView(kol), totalKols: kolStore.size() });
  });
  app.post("/v1/kols/discover", admin, async (_req, res) => {
    if (!config.heliusApiKey) {
      res.status(503).json({ error: "ingestion_not_configured" });
      return;
    }
    res.json(await autoSourcer.runOnce());
  });
  // Free, explicitly limited preview. No forged payment headers in the frontend.
  app.get("/v1/signals/preview", (_req, res) =>
    res.json({
      signals: signalStore.query({ limit: 7 }).map(sanitizeSignal),
      dataMode: dataMode(),
      ingestion: ingestionEngine.getStatus(),
      limited: true,
    }),
  );
  app.get(
    "/v1/signals",
    validate(signalQuery),
    requireLiveData,
    payment.middleware,
    (_req, res) => {
      const signals = signalStore.query(res.locals.query).map(sanitizeSignal);
      res.json({
        signals,
        count: signals.length,
        query: res.locals.query,
        dataMode: dataMode(),
      });
    },
  );
  app.get(
    "/v1/signals/consensus",
    validate(consensusQuery),
    requireLiveData,
    payment.middleware,
    (_req, res) => {
      const consensus = signalStore.getConsensus(res.locals.query);
      res.json({
        consensus,
        count: consensus.length,
        query: res.locals.query,
        dataMode: dataMode(),
      });
    },
  );
  app.get(
    "/v1/signals/social",
    validate(socialQuery),
    (req, res, next) => {
      if (!xMonitor.isEnabled() || xMonitor.getStats().monitored === 0) {
        res.status(503).json({ error: "social_not_configured" });
        return;
      }
      next();
    },
    payment.middleware,
    (_req, res) => {
      const signals = xMonitor.getSocialSignals(res.locals.query);
      res.json({
        signals,
        count: signals.length,
        provider: xMonitor.getProviderName(),
      });
    },
  );
  app.get("/v1/stats", (_req, res) => {
    const signals = signalStore.query({
      maxAge: 300,
      limit: config.maxSignalsInMemory,
    });
    res.json({
      window: "5m",
      signalCount: signals.length,
      buys: signals.filter((s) => s.action === "BUY").length,
      sells: signals.filter((s) => s.action === "SELL").length,
      avgConviction: signals.length
        ? Math.round(
            signals.reduce((sum, s) => sum + s.conviction, 0) / signals.length,
          )
        : 0,
      uniqueTokens: new Set(signals.map((s) => s.tokenMint)).size,
      activeKols: new Set(signals.map((s) => s.kol.address)).size,
      totalKolsTracked: kolStore.size(),
      dataMode: dataMode(),
    });
  });
  app.use(express.static(path.resolve(__dirname, "../../public")));
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", docs: "/docs/" });
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    const status =
      error.type === "entity.parse.failed"
        ? 400
        : error.type === "entity.too.large"
          ? 413
          : 500;
    res
      .status(status)
      .json({ error: status === 500 ? "internal_error" : "invalid_request" });
  };
  app.use(errorHandler);
  const close = () => {
    ingestionEngine.stop();
    autoSourcer.stop();
    statsEngine.stop();
    xMonitor.stop();
    signalStore.destroy();
  };
  return {
    app,
    kolStore,
    signalStore,
    scoringEngine,
    ingestionEngine,
    xMonitor,
    autoSourcer,
    statsEngine,
    close,
  };
}
export function createServer() {
  const runtime = createApp();
  const server = runtime.app.listen(config.port, config.host, () => {
    console.log(
      `[Sentric] http://${config.host}:${config.port} — ${runtime.kolStore.size()} watched wallets`,
    );
    if (config.heliusApiKey) {
      void runtime.ingestionEngine.start();
      if (config.backfill) void runtime.statsEngine.backfillAndComputeStats();
      if (config.autoDiscovery && config.adminApiKey)
        runtime.autoSourcer.start();
    }
    if (runtime.xMonitor.isEnabled())
      void runtime.xMonitor
        .start()
        .catch(() => console.error("[SOCIAL] Could not start monitor"));
  });
  const shutdown = () => {
    runtime.close();
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { ...runtime, server };
}
export function sanitizeSignal(signal: ScoredSignal) {
  return {
    id: signal.id,
    kol: {
      label: signal.kol.label,
      address: signal.kol.address,
      tier: signal.kol.tier,
      attribution: "operator_supplied",
    },
    action: signal.action,
    token: signal.token,
    tokenMint: signal.tokenMint,
    quoteMint: signal.quoteMint,
    conviction: signal.conviction,
    scoreType: "heuristic",
    historicalMetrics: signal.kol.metricsSource || "unknown",
    breakdown: signal.breakdown,
    consensusKols: signal.consensusKols,
    timestamp: signal.timestamp,
    expiresAt: signal.expiresAt,
    signature: signal.swap.signature,
  };
}
