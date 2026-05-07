import WebSocket from "ws";
import { config } from "../config";
import { KolStore } from "../config/kols";
import { parseHeliusTransaction } from "./parser";
import { ScoringEngine } from "../scoring/engine";
import { SignalStore } from "../store/signal-store";
import { HeliusTransaction } from "../types";

export class IngestionEngine {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private processedSigs = new Set<string>();
  private maxProcessedCache = 50_000;

  constructor(
    private kolStore: KolStore,
    private scoringEngine: ScoringEngine,
    private signalStore: SignalStore
  ) {}

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(
      `[INGEST] Starting ingestion for ${this.kolStore.size()} KOL wallets`
    );

    // Try WebSocket first (real-time)
    if (config.heliusWsUrl) {
      this.connectWebSocket();
    }

    // Always run polling as fallback / primary
    this.startPolling();
  }

  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    console.log("[INGEST] Stopped");
  }

  // ===========================================
  // WebSocket — Helius Enhanced WebSocket
  // ===========================================

  private connectWebSocket(): void {
    if (!config.heliusWsUrl) return;

    console.log("[INGEST] Connecting WebSocket...");

    try {
      this.ws = new WebSocket(config.heliusWsUrl);

      this.ws.on("open", () => {
        console.log("[INGEST] WebSocket connected");
        this.subscribeToWallets();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWebSocketMessage(msg);
        } catch (err) {
          // Ignore parse errors on heartbeats etc.
        }
      });

      this.ws.on("close", () => {
        console.log("[INGEST] WebSocket disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[INGEST] WebSocket error:", err.message);
        this.scheduleReconnect();
      });
    } catch (err) {
      console.error("[INGEST] WebSocket connection failed:", err);
      this.scheduleReconnect();
    }
  }

  private subscribeToWallets(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const addresses = this.kolStore.getAllAddresses();

    // Helius enhanced WebSocket subscription
    // Subscribe in batches of 100 to avoid oversized messages
    const batchSize = 100;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const subscribeMsg = {
        jsonrpc: "2.0",
        id: `sub-${i}`,
        method: "transactionSubscribe",
        params: [
          {
            accountInclude: batch,
          },
          {
            commitment: "confirmed",
            encoding: "jsonParsed",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 0,
          },
        ],
      };
      this.ws.send(JSON.stringify(subscribeMsg));
    }

    console.log(
      `[INGEST] Subscribed to ${addresses.length} wallet(s) via WebSocket`
    );
  }

  private handleWebSocketMessage(msg: any): void {
    // Helius enhanced WS returns transaction notifications
    if (msg.params?.result?.transaction) {
      const tx = msg.params.result.transaction as HeliusTransaction;
      this.processTransaction(tx);
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      console.log("[INGEST] Reconnecting WebSocket...");
      this.connectWebSocket();
    }, 5000);
  }

  // ===========================================
  // Polling — Helius Enhanced Transactions API
  // ===========================================

  private startPolling(): void {
    const interval = 10_000; // Poll every 10 seconds
    console.log(`[INGEST] Starting polling (every ${interval / 1000}s)`);

    // Initial poll
    this.pollAllWallets();

    // Recurring
    this.pollTimer = setInterval(() => {
      this.pollAllWallets();
    }, interval);
  }

  private async pollAllWallets(): Promise<void> {
    const addresses = this.kolStore.getAllAddresses();

    // Batch addresses to avoid rate limits
    // Helius free tier: 30 req/s, paid: higher
    const concurrency = 5;

    for (let i = 0; i < addresses.length; i += concurrency) {
      const batch = addresses.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((addr) => this.pollWallet(addr))
      );
    }
  }

  private async pollWallet(address: string): Promise<void> {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config.heliusApiKey}&limit=5&type=SWAP`;

      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited, back off
          return;
        }
        return;
      }

      const transactions = (await response.json()) as HeliusTransaction[];

      for (const tx of transactions) {
        this.processTransaction(tx, address);
      }
    } catch (err: any) {
      // Silently handle errors on individual wallet polls
      // In production, add structured logging
    }
  }

  // ===========================================
  // Transaction Processing
  // ===========================================

  private processTransaction(
    tx: HeliusTransaction,
    knownWallet?: string
  ): void {
    // Deduplicate
    if (this.processedSigs.has(tx.signature)) return;
    this.processedSigs.add(tx.signature);

    // Trim cache
    if (this.processedSigs.size > this.maxProcessedCache) {
      const entries = Array.from(this.processedSigs);
      for (let i = 0; i < entries.length - this.maxProcessedCache / 2; i++) {
        this.processedSigs.delete(entries[i]);
      }
    }

    // Determine which KOL wallet is involved
    const wallet =
      knownWallet || this.findKolWallet(tx);
    if (!wallet) return;

    const kol = this.kolStore.get(wallet);
    if (!kol) return;

    // Parse the transaction into a swap
    const swap = parseHeliusTransaction(tx, wallet);
    if (!swap) return;

    // Score it
    const signal = this.scoringEngine.score(swap, kol);

    // Store it
    this.signalStore.add(signal);

    console.log(
      `[SIGNAL] ${signal.kol.label} ${signal.action} ${signal.token} | conviction: ${signal.conviction}/100 | consensus: ${signal.consensusKols.length} KOLs`
    );
  }

  private findKolWallet(tx: HeliusTransaction): string | null {
    // Check feePayer
    if (this.kolStore.has(tx.feePayer)) return tx.feePayer;

    // Check native transfers
    for (const transfer of tx.nativeTransfers || []) {
      if (this.kolStore.has(transfer.fromUserAccount))
        return transfer.fromUserAccount;
    }

    // Check token transfers
    for (const transfer of tx.tokenTransfers || []) {
      if (this.kolStore.has(transfer.fromUserAccount))
        return transfer.fromUserAccount;
    }

    return null;
  }
}
