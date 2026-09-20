import { config } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { ScoringEngine } from "../scoring/engine";
import { parseHeliusTransaction } from "../ingestion/parser";
import { HeliusTransaction } from "../types";

/** Optional recent-signal backfill. A partial transaction window cannot establish
 * realized PnL or rug avoidance; historical metrics stay unknown. */
export class KolStatsEngine {
  private stopped = false;
  constructor(
    private kolStore: KolStore,
    private signalStore: SignalStore,
    private scoringEngine: ScoringEngine,
  ) {}
  stop() {
    this.stopped = true;
  }
  async backfillAndComputeStats(): Promise<void> {
    if (!config.heliusApiKey) return;
    for (const kol of this.kolStore.getAll()) {
      if (this.stopped) break;
      try {
        const response = await fetch(
          `https://api.helius.xyz/v0/addresses/${kol.address}/transactions?api-key=${config.heliusApiKey}&limit=100&type=SWAP`,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) continue;
        const transactions = (await response.json()) as HeliusTransaction[];
        for (const tx of transactions.reverse()) {
          if (this.stopped) return;
          if (Date.now() - tx.timestamp * 1000 > config.signalTtlSeconds * 1000)
            continue;
          const swap = parseHeliusTransaction(tx, kol.address);
          if (swap)
            this.signalStore.add(await this.scoringEngine.score(swap, kol));
        }
      } catch {
        console.warn("[BACKFILL] Provider unavailable for wallet", kol.address);
      }
    }
  }
}
