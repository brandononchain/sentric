import { ScoredSignal, SignalQuery, ConsensusQuery, ConsensusSignal } from "../types";
import { config } from "../config";

export class SignalStore {
  private signals: Map<string, ScoredSignal> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Sweep expired signals every 10 seconds
    this.cleanupInterval = setInterval(() => this.sweep(), 10_000);
  }

  add(signal: ScoredSignal): void {
    this.signals.set(signal.id, signal);

    // Enforce max capacity
    if (this.signals.size > config.maxSignalsInMemory) {
      const oldest = this.getOldest();
      if (oldest) this.signals.delete(oldest.id);
    }
  }

  /** Return all live signals (newest first) — used by the X monitor to
   *  cross-reference tweets against recent on-chain buys. */
  getAll(): ScoredSignal[] {
    return Array.from(this.signals.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );
  }

  query(q: SignalQuery): ScoredSignal[] {
    const now = Date.now();
    const maxAgeMs = (q.maxAge || config.signalTtlSeconds) * 1000;
    const limit = q.limit || 50;

    let results: ScoredSignal[] = [];

    for (const signal of this.signals.values()) {
      // Check expiry
      if (now - signal.timestamp > maxAgeMs) continue;

      // Conviction filter
      if (q.minConviction && signal.conviction < q.minConviction) continue;

      // Action filter
      if (q.action && signal.action !== q.action) continue;

      // Token filter (match symbol or mint)
      if (q.tokenFilter && q.tokenFilter.length > 0) {
        const tokenMatch = q.tokenFilter.some(
          (t) =>
            signal.token.toUpperCase().includes(t.toUpperCase()) ||
            signal.tokenMint === t
        );
        if (!tokenMatch) continue;
      }

      // KOL filter
      if (q.kolFilter && q.kolFilter.length > 0) {
        const kolMatch = q.kolFilter.some(
          (k) =>
            signal.kol.label.toLowerCase().includes(k.toLowerCase()) ||
            signal.kol.address === k
        );
        if (!kolMatch) continue;
      }

      results.push(signal);
    }

    // Sort by timestamp desc (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    return results.slice(0, limit);
  }

  getConsensus(q: ConsensusQuery): ConsensusSignal[] {
    const now = Date.now();
    const windowMs = (q.window || 300) * 1000;
    const minKols = q.minKols || 2;
    const minConviction = q.minConviction || 0;
    const limit = q.limit || 20;

    // Group recent signals by tokenMint
    const tokenGroups: Map<
      string,
      Array<{
        label: string;
        address: string;
        conviction: number;
        action: "BUY" | "SELL";
        timestamp: number;
      }>
    > = new Map();

    const tokenNames: Map<string, string> = new Map();

    for (const signal of this.signals.values()) {
      if (now - signal.timestamp > windowMs) continue;
      if (signal.conviction < minConviction) continue;

      const mint = signal.tokenMint;
      if (!tokenGroups.has(mint)) {
        tokenGroups.set(mint, []);
        tokenNames.set(mint, signal.token);
      }

      // Deduplicate by KOL address (only latest signal per KOL per token)
      const group = tokenGroups.get(mint)!;
      const existingIdx = group.findIndex((g) => g.address === signal.kol.address);
      if (existingIdx >= 0) {
        if (signal.timestamp > group[existingIdx].timestamp) {
          group[existingIdx] = {
            label: signal.kol.label,
            address: signal.kol.address,
            conviction: signal.conviction,
            action: signal.action,
            timestamp: signal.timestamp,
          };
        }
      } else {
        group.push({
          label: signal.kol.label,
          address: signal.kol.address,
          conviction: signal.conviction,
          action: signal.action,
          timestamp: signal.timestamp,
        });
      }
    }

    // Build consensus signals where kolCount >= minKols
    const results: ConsensusSignal[] = [];

    for (const [mint, kols] of tokenGroups.entries()) {
      if (kols.length < minKols) continue;

      const avgConviction =
        kols.reduce((sum, k) => sum + k.conviction, 0) / kols.length;
      const timestamps = kols.map((k) => k.timestamp);

      results.push({
        token: tokenNames.get(mint) || mint.slice(0, 8),
        tokenMint: mint,
        kols,
        avgConviction: Math.round(avgConviction),
        kolCount: kols.length,
        firstSeen: Math.min(...timestamps),
        lastSeen: Math.max(...timestamps),
      });
    }

    // Sort by kolCount desc, then avgConviction desc
    results.sort(
      (a, b) => b.kolCount - a.kolCount || b.avgConviction - a.avgConviction
    );

    return results.slice(0, limit);
  }

  // Get recent unique tokens being traded by KOLs (for consensus detection)
  getRecentTokenTraders(
    tokenMint: string,
    windowMs: number
  ): string[] {
    const now = Date.now();
    const traders = new Set<string>();
    for (const signal of this.signals.values()) {
      if (signal.tokenMint !== tokenMint) continue;
      if (now - signal.timestamp > windowMs) continue;
      traders.add(signal.kol.label);
    }
    return Array.from(traders);
  }

  size(): number {
    return this.signals.size;
  }

  private getOldest(): ScoredSignal | null {
    let oldest: ScoredSignal | null = null;
    for (const signal of this.signals.values()) {
      if (!oldest || signal.timestamp < oldest.timestamp) {
        oldest = signal;
      }
    }
    return oldest;
  }

  private sweep(): void {
    const now = Date.now();
    const ttlMs = config.signalTtlSeconds * 1000;
    for (const [id, signal] of this.signals.entries()) {
      if (now - signal.timestamp > ttlMs) {
        this.signals.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }
}
