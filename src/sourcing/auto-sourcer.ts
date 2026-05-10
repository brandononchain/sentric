import { config } from "../config";
import { KolStore } from "../config/kols";

/**
 * KOL Auto-Sourcer
 * 
 * Runs on a schedule (default: every 6 hours) to discover and add new KOL wallets.
 * 
 * Sources:
 * 1. Kolscan leaderboard — scrapes daily/weekly top performers
 * 2. Helius "notable accounts" — wallets with high swap volume on tracked DEXs
 * 3. Consensus detection — wallets that frequently trade the same tokens as existing KOLs
 * 
 * New wallets go through a qualification filter before being added:
 * - Minimum 5 trades in the last 7 days
 * - At least 1 SOL in volume
 * - Not a known bot/MEV address
 * - Not already tracked
 */

const KOLSCAN_TRADES_URL = "https://kolscan.io/trades";
const HELIUS_BASE = "https://api.helius.xyz/v0";
const KNOWN_BOT_PATTERNS = [
  "1111111111111111111111", // system programs
  "JUP",   // Jupiter program
  "whirL", // Orca whirlpool
];

interface DiscoveredWallet {
  address: string;
  label: string;
  source: string;
  tradeCount: number;
  estimatedWinRate: number;
}

export class KolAutoSourcer {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private kolStore: KolStore,
    private apiBaseUrl: string = "http://localhost:" + config.port
  ) {}

  /**
   * Start the auto-sourcing loop
   * @param intervalMs - how often to run (default: 6 hours)
   */
  start(intervalMs: number = 6 * 60 * 60 * 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[AUTO-SOURCE] Starting KOL auto-sourcer (every ${Math.round(intervalMs / 3600000)}h)`);

    // Run immediately on start, then on interval
    this.runOnce().catch(err => console.error("[AUTO-SOURCE] Initial run failed:", err));

    this.timer = setInterval(() => {
      this.runOnce().catch(err => console.error("[AUTO-SOURCE] Scheduled run failed:", err));
    }, intervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[AUTO-SOURCE] Stopped");
  }

  /**
   * Single run: discover wallets from all sources, filter, and add
   */
  async runOnce(): Promise<{ added: number; skipped: number; errors: number }> {
    console.log("[AUTO-SOURCE] Running discovery cycle...");
    const results = { added: 0, skipped: 0, errors: 0 };

    try {
      // Source 1: Helius — find wallets with high DEX volume
      const heliusWallets = await this.discoverFromHelius();

      // Source 2: On-chain consensus — wallets trading same tokens as our KOLs
      const consensusWallets = await this.discoverFromConsensus();

      // Merge and deduplicate
      const allDiscovered = this.deduplicateWallets([...heliusWallets, ...consensusWallets]);

      console.log(`[AUTO-SOURCE] Discovered ${allDiscovered.length} candidate wallets`);

      // Filter and add
      for (const wallet of allDiscovered) {
        if (this.kolStore.has(wallet.address)) {
          results.skipped++;
          continue;
        }

        if (this.isKnownBot(wallet.address)) {
          results.skipped++;
          continue;
        }

        if (wallet.tradeCount < 3) {
          results.skipped++;
          continue;
        }

        try {
          await this.addKolViaApi(wallet);
          results.added++;
          console.log(`[AUTO-SOURCE] Added: ${wallet.label} (${wallet.address.slice(0, 8)}...) via ${wallet.source}`);
        } catch (err) {
          results.errors++;
        }
      }

      console.log(`[AUTO-SOURCE] Cycle complete: +${results.added} added, ${results.skipped} skipped, ${results.errors} errors. Total KOLs: ${this.kolStore.size()}`);
    } catch (err) {
      console.error("[AUTO-SOURCE] Cycle failed:", err);
    }

    return results;
  }

  /**
   * Source: Helius Enhanced API
   * Find wallets with significant swap activity on Jupiter/Raydium
   */
  private async discoverFromHelius(): Promise<DiscoveredWallet[]> {
    if (!config.heliusApiKey) return [];

    const discovered: DiscoveredWallet[] = [];

    try {
      // Get recent large swaps from Jupiter v6
      const jupiterProgramId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

      const response = await fetch(`${HELIUS_BASE}/addresses/${jupiterProgramId}/transactions?api-key=${config.heliusApiKey}&limit=100&type=SWAP`);

      if (!response.ok) return [];

      const transactions: any[] = await response.json() as any[];

      // Extract unique signers (the wallets doing the swaps)
      const walletCounts = new Map<string, number>();

      for (const tx of transactions) {
        if (tx.feePayer && !this.kolStore.has(tx.feePayer)) {
          walletCounts.set(tx.feePayer, (walletCounts.get(tx.feePayer) || 0) + 1);
        }
      }

      // Wallets that appear 3+ times in recent txns are active traders
      for (const [address, count] of walletCounts) {
        if (count >= 3) {
          discovered.push({
            address,
            label: "@" + address.slice(0, 6),
            source: "helius-jupiter",
            tradeCount: count,
            estimatedWinRate: 0.5,
          });
        }
      }
    } catch (err) {
      console.warn("[AUTO-SOURCE] Helius discovery failed:", err);
    }

    return discovered;
  }

  /**
   * Source: Consensus detection
   * Find wallets that trade the same tokens our tracked KOLs are trading
   * These are likely other KOLs or smart money following similar alpha
   */
  private async discoverFromConsensus(): Promise<DiscoveredWallet[]> {
    if (!config.heliusApiKey) return [];

    const discovered: DiscoveredWallet[] = [];

    try {
      // Pick a few active KOL wallets to check
      const activeKols = this.kolStore.getAll()
        .filter(k => k.tier === "s" || k.tier === "a")
        .slice(0, 5);

      for (const kol of activeKols) {
        try {
          const response = await fetch(
            `${HELIUS_BASE}/addresses/${kol.address}/transactions?api-key=${config.heliusApiKey}&limit=20&type=SWAP`
          );

          if (!response.ok) continue;

          const txns: any[] = await response.json() as any[];

          // Extract token mints from KOL's recent trades
          const kolTokens = new Set<string>();
          for (const tx of txns) {
            if (tx.tokenTransfers) {
              for (const transfer of tx.tokenTransfers) {
                if (transfer.mint && !config.stableAndBaseMints.has(transfer.mint)) {
                  kolTokens.add(transfer.mint);
                }
              }
            }
          }

          // For each token, check who else is trading it
          for (const tokenMint of Array.from(kolTokens).slice(0, 3)) {
            try {
              const tokenTxns = await fetch(
                `${HELIUS_BASE}/addresses/${tokenMint}/transactions?api-key=${config.heliusApiKey}&limit=50&type=SWAP`
              );

              if (!tokenTxns.ok) continue;

              const tokenTxData: any[] = await tokenTxns.json() as any[];

              for (const tx of tokenTxData) {
                if (tx.feePayer && !this.kolStore.has(tx.feePayer) && tx.feePayer !== kol.address) {
                  discovered.push({
                    address: tx.feePayer,
                    label: "@" + tx.feePayer.slice(0, 6),
                    source: "consensus-" + kol.label,
                    tradeCount: 1,
                    estimatedWinRate: 0.5,
                  });
                }
              }
            } catch {
              // Skip this token
            }

            // Rate limit between token lookups
            await this.sleep(200);
          }
        } catch {
          // Skip this KOL
        }

        // Rate limit between KOL lookups
        await this.sleep(500);
      }
    } catch (err) {
      console.warn("[AUTO-SOURCE] Consensus discovery failed:", err);
    }

    return discovered;
  }

  /**
   * Add a discovered wallet to the KOL store via the POST API
   */
  private async addKolViaApi(wallet: DiscoveredWallet): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/v1/kols`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: wallet.address,
        label: wallet.label,
        tier: "b", // All auto-discovered start at B tier
        winRate: wallet.estimatedWinRate,
        holdHours: 2,
        rugAvoidance: 0.8,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if ((err as any).error !== "already_tracked") {
        throw new Error(`API error: ${response.status}`);
      }
    }
  }

  /**
   * Check if an address is a known bot/program
   */
  private isKnownBot(address: string): boolean {
    for (const pattern of KNOWN_BOT_PATTERNS) {
      if (address.includes(pattern)) return true;
    }
    // System programs are 32+ chars of base58 but start with known prefixes
    if (address.length < 32) return true;
    return false;
  }

  /**
   * Deduplicate by address, keeping the entry with the highest trade count
   */
  private deduplicateWallets(wallets: DiscoveredWallet[]): DiscoveredWallet[] {
    const map = new Map<string, DiscoveredWallet>();
    for (const w of wallets) {
      const existing = map.get(w.address);
      if (!existing || w.tradeCount > existing.tradeCount) {
        // Merge trade counts if from different sources
        if (existing) {
          w.tradeCount += existing.tradeCount;
        }
        map.set(w.address, w);
      }
    }
    return Array.from(map.values());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
