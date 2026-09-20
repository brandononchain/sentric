import WebSocket from "ws";
import { config } from "../config";
import { KolStore } from "../config/kols";
import { parseHeliusTransaction } from "./parser";
import { ScoringEngine } from "../scoring/engine";
import { SignalStore } from "../store/signal-store";
import { HeliusTransaction } from "../types";

export class IngestionEngine {
  private ws: WebSocket | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private running = false;
  private polling = false;
  private processed = new Set<string>();
  private inFlight = new Set<string>();
  private hydration = new Set<string>();
  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastSignalAt: number | null = null;
  private failures = 0;
  constructor(
    private kolStore: KolStore,
    private scoringEngine: ScoringEngine,
    private signalStore: SignalStore,
  ) {}
  getStatus() {
    return {
      enabled: !!config.heliusApiKey,
      running: this.running,
      websocketConnected: this.ws?.readyState === WebSocket.OPEN,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastSignalAt: this.lastSignalAt,
      failures: this.failures,
      stale:
        this.running &&
        (!this.lastSuccessAt || Date.now() - this.lastSuccessAt > 60_000),
    };
  }
  async start() {
    if (this.running) return;
    this.running = true;
    if (config.heliusWsUrl) this.connect();
    void this.poll();
  }
  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pollTimer);
    this.ws?.close();
    this.ws = null;
  }
  async addWallet(address: string) {
    this.subscribe([address]);
  }
  private subscribe(addresses: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < addresses.length; i += 100) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now() + i,
          method: "transactionSubscribe",
          params: [
            {
              accountInclude: addresses.slice(i, i + 100),
              failed: false,
              vote: false,
            },
            {
              commitment: "confirmed",
              encoding: "jsonParsed",
              transactionDetails: "full",
              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      );
    }
  }
  private connect() {
    if (!this.running) return;
    this.ws = new WebSocket(config.heliusWsUrl, { handshakeTimeout: 10000 });
    this.ws.on("open", () => this.subscribe(this.kolStore.getAllAddresses()));
    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.error) {
          this.failures++;
          return;
        }
        const result = message.params?.result;
        const signature =
          result?.signature ||
          result?.transaction?.transaction?.signatures?.[0];
        if (typeof signature === "string") void this.hydrate(signature);
      } catch {
        this.failures++;
      }
    });
    this.ws.on("error", () => {
      this.failures++;
      this.ws?.terminate();
    });
    this.ws.on("close", () => {
      if (this.running)
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }
  private async hydrate(signature: string) {
    if (
      this.hydration.has(signature) ||
      this.hydration.size >= 20 ||
      !this.running
    )
      return;
    this.hydration.add(signature);
    try {
      // Enhanced WebSocket notifications are raw RPC transactions, not Enhanced API objects.
      const response = await fetch(
        `https://api.helius.xyz/v0/transactions?api-key=${config.heliusApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: [signature] }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("provider_unavailable");
      const transactions = (await response.json()) as HeliusTransaction[];
      this.lastSuccessAt = Date.now();
      for (const tx of transactions) {
        for (const wallet of this.kolStore.getAllAddresses())
          await this.processTransaction(tx, wallet);
      }
    } catch {
      this.failures++;
    } finally {
      this.hydration.delete(signature);
    }
  }
  private async poll() {
    if (!this.running || this.polling) return;
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const addresses = this.kolStore.getAllAddresses();
      for (let i = 0; i < addresses.length && this.running; i += 3) {
        await Promise.allSettled(
          addresses.slice(i, i + 3).map((address) => this.pollWallet(address)),
        );
      }
    } finally {
      this.polling = false;
      // Schedule after completion: slow providers cannot create overlapping polls.
      if (this.running)
        this.pollTimer = setTimeout(() => void this.poll(), 10000);
    }
  }
  private async pollWallet(address: string) {
    try {
      const response = await fetch(
        `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config.heliusApiKey}&limit=20&type=SWAP`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error("provider_unavailable");
      const transactions = (await response.json()) as HeliusTransaction[];
      this.lastSuccessAt = Date.now();
      for (const tx of transactions.reverse())
        await this.processTransaction(tx, address);
    } catch {
      this.failures++;
    }
  }
  private async processTransaction(tx: HeliusTransaction, wallet: string) {
    if (
      !this.running ||
      !tx.signature ||
      Date.now() - tx.timestamp * 1000 > config.signalTtlSeconds * 1000
    )
      return;
    const key = `${tx.signature}:${wallet}`;
    if (this.processed.has(key) || this.inFlight.has(key)) return;
    const kol = this.kolStore.get(wallet);
    if (!kol) return;
    const swap = parseHeliusTransaction(tx, wallet);
    if (!swap) return;
    this.inFlight.add(key);
    try {
      const signal = await this.scoringEngine.score(swap, kol);
      if (!this.running) return;
      this.signalStore.add(signal);
      this.lastSignalAt = Date.now();
      this.processed.add(key);
      if (this.processed.size > 50000)
        this.processed.delete(this.processed.values().next().value!);
    } finally {
      this.inFlight.delete(key);
    }
  }
}
