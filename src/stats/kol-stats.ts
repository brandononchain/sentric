/**
 * KOL Stats Engine
 * 
 * Computes real KOL statistics from on-chain transaction history:
 * - Win rate: % of tokens bought that were sold at a profit
 * - Average hold duration: median time between buy and first sell
 * - Rug avoidance: % of tokens bought that didn't go to zero
 * - Total trades: actual counted from Helius
 * 
 * Also handles historical backfill on startup — pulls last 24h of
 * transactions for all KOLs and pre-loads the signal store.
 */

import { config } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { ScoringEngine } from "../scoring/engine";
import { parseHeliusTransaction } from "../ingestion/parser";
import { priceOracle } from "../oracle/price";
import { HeliusTransaction, KolProfile } from "../types";

const HELIUS_BASE = "https://api.helius.xyz/v0";

interface TradeRecord {
  tokenMint: string;
  action: "BUY" | "SELL";
  timestamp: number;
  usdValue: number;
  signature: string;
}

interface TokenPosition {
  mint: string;
  totalBoughtUsd: number;
  totalSoldUsd: number;
  firstBuyTs: number;
  firstSellTs: number | null;
  tradeCount: number;
}

export class KolStatsEngine {
  constructor(
    private kolStore: KolStore,
    private signalStore: SignalStore,
    private scoringEngine: ScoringEngine
  ) {}

  /**
   * Run full backfill and stats computation for all KOLs.
   * Called once on server startup.
   */
  async backfillAndComputeStats(): Promise<void> {
    if (!config.heliusApiKey) {
      console.log("[STATS] No Helius key — skipping backfill");
      return;
    }

    console.log(`[STATS] Starting historical backfill for ${this.kolStore.size()} KOLs...`);

    const allKols = this.kolStore.getAll();
    let totalSignals = 0;
    let kolsProcessed = 0;

    // Process KOLs in batches to respect rate limits
    const batchSize = 3;
    for (let i = 0; i < allKols.length; i += batchSize) {
      const batch = allKols.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(kol => this.processKolHistory(kol))
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          totalSignals += result.value;
        }
      }

      kolsProcessed += batch.length;

      // Log progress every 10 KOLs
      if (kolsProcessed % 10 === 0 || kolsProcessed === allKols.length) {
        console.log(`[STATS] Progress: ${kolsProcessed}/${allKols.length} KOLs, ${totalSignals} signals loaded`);
      }

      // Rate limit between batches (Helius free: 30 req/s)
      await this.sleep(1000);
    }

    console.log(`[STATS] Backfill complete: ${totalSignals} signals from ${kolsProcessed} KOLs`);
  }

  /**
   * Process a single KOL: fetch history, compute stats, backfill signals
   */
  private async processKolHistory(kol: KolProfile): Promise<number> {
    try {
      // Fetch last 100 transactions (Helius max per request)
      const transactions = await this.fetchKolTransactions(kol.address, 100);
      if (!transactions || transactions.length === 0) return 0;

      // Extract trade records for stats computation
      const trades = await this.extractTrades(transactions, kol.address);

      // Compute real stats from trade history
      if (trades.length > 0) {
        await this.computeAndUpdateStats(kol, trades);
      }

      // Parse recent transactions (last 24h) into scored signals for the store
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      let signalsAdded = 0;

      for (const tx of transactions) {
        const txTimestamp = (tx.timestamp || 0) * 1000; // Helius returns seconds
        if (txTimestamp < oneDayAgo) continue;

        const swap = parseHeliusTransaction(tx, kol.address);
        if (!swap) continue;

        const signal = await this.scoringEngine.score(swap, kol);
        this.signalStore.add(signal);
        signalsAdded++;
      }

      return signalsAdded;
    } catch (err: any) {
      console.warn(`[STATS] Failed to process ${kol.label}: ${err.message || err}`);
      return 0;
    }
  }

  /**
   * Fetch transactions from Helius Enhanced API
   */
  private async fetchKolTransactions(address: string, limit: number): Promise<HeliusTransaction[]> {
    try {
      const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${config.heliusApiKey}&limit=${limit}&type=SWAP`;
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited — wait and retry once
          await this.sleep(2000);
          const retry = await fetch(url);
          if (!retry.ok) return [];
          return await retry.json() as HeliusTransaction[];
        }
        return [];
      }

      return await response.json() as HeliusTransaction[];
    } catch {
      return [];
    }
  }

  /**
   * Extract structured trade records from raw Helius transactions
   */
  private async extractTrades(transactions: HeliusTransaction[], walletAddress: string): Promise<TradeRecord[]> {
    const trades: TradeRecord[] = [];
    const solMint = "So11111111111111111111111111111111111111112";

    for (const tx of transactions) {
      if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;

      // Find the token being traded (not SOL, not USDC)
      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint;
        if (!mint) continue;
        if (config.stableAndBaseMints.has(mint)) continue;

        const isBuy = transfer.toUserAccount === walletAddress;
        const isSell = transfer.fromUserAccount === walletAddress;

        if (!isBuy && !isSell) continue;

        // Estimate USD value from associated SOL or USDC transfers
        let usdValue = 0;

        // Check native SOL transfers
        if (tx.nativeTransfers) {
          for (const nt of tx.nativeTransfers) {
            if (nt.fromUserAccount === walletAddress || nt.toUserAccount === walletAddress) {
              const solAmount = Math.abs(nt.amount) / 1e9;
              const solPrice = await priceOracle.getSolPrice();
              usdValue = Math.max(usdValue, solAmount * solPrice);
            }
          }
        }

        // Check USDC transfers
        for (const tt of tx.tokenTransfers) {
          if (tt.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
            usdValue = Math.max(usdValue, Math.abs(tt.tokenAmount) || 0);
          }
        }

        trades.push({
          tokenMint: mint,
          action: isBuy ? "BUY" : "SELL",
          timestamp: (tx.timestamp || 0) * 1000,
          usdValue,
          signature: tx.signature,
        });
      }
    }

    return trades;
  }

  /**
   * Compute real stats from trade history and update the KOL profile
   */
  private async computeAndUpdateStats(kol: KolProfile, trades: TradeRecord[]): Promise<void> {
    // Group trades by token
    const positions = new Map<string, TokenPosition>();

    for (const trade of trades) {
      let pos = positions.get(trade.tokenMint);
      if (!pos) {
        pos = {
          mint: trade.tokenMint,
          totalBoughtUsd: 0,
          totalSoldUsd: 0,
          firstBuyTs: 0,
          firstSellTs: null,
          tradeCount: 0,
        };
        positions.set(trade.tokenMint, pos);
      }

      pos.tradeCount++;

      if (trade.action === "BUY") {
        pos.totalBoughtUsd += trade.usdValue;
        if (!pos.firstBuyTs) pos.firstBuyTs = trade.timestamp;
      } else {
        pos.totalSoldUsd += trade.usdValue;
        if (!pos.firstSellTs) pos.firstSellTs = trade.timestamp;
      }
    }

    // Compute win rate: % of positions where sold > bought
    let wins = 0;
    let closedPositions = 0;
    const holdDurations: number[] = [];
    let rugs = 0;
    let totalPositions = 0;

    for (const pos of positions.values()) {
      totalPositions++;

      if (pos.totalSoldUsd > 0 && pos.totalBoughtUsd > 0) {
        closedPositions++;
        if (pos.totalSoldUsd > pos.totalBoughtUsd) {
          wins++;
        }
      }

      // Hold duration: time between first buy and first sell
      if (pos.firstBuyTs && pos.firstSellTs) {
        const holdMs = pos.firstSellTs - pos.firstBuyTs;
        if (holdMs > 0) holdDurations.push(holdMs);
      }

      // Rug detection: bought but current value is near zero
      // Check if token still has any value
      if (pos.totalBoughtUsd > 10 && pos.totalSoldUsd === 0) {
        const currentPrice = await priceOracle.getPrice(pos.mint);
        if (currentPrice === 0) {
          rugs++;
        }
      }
    }

    // Update KOL profile with real data
    const totalTrades = trades.length;

    if (closedPositions > 0) {
      kol.historicalWinRate = wins / closedPositions;
    }

    if (holdDurations.length > 0) {
      // Use median hold duration
      holdDurations.sort((a, b) => a - b);
      kol.avgHoldDurationMs = holdDurations[Math.floor(holdDurations.length / 2)];
    }

    if (totalPositions > 0) {
      kol.rugAvoidanceRate = 1 - (rugs / totalPositions);
    }

    kol.totalTrackedTrades = totalTrades;

    console.log(
      `[STATS] ${kol.label}: ${totalTrades} trades, ` +
      `${closedPositions > 0 ? Math.round(kol.historicalWinRate * 100) : '?'}% win rate, ` +
      `${holdDurations.length > 0 ? Math.round(kol.avgHoldDurationMs / 3600000 * 10) / 10 : '?'}h avg hold, ` +
      `${Math.round(kol.rugAvoidanceRate * 100)}% rug avoidance`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
