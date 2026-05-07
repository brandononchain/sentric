import {
  KolProfile,
  ParsedSwap,
  ConvictionBreakdown,
  ScoredSignal,
} from "../types";
import { config } from "../config";
import { classifySwapAction } from "../ingestion/parser";
import { SignalStore } from "../store/signal-store";
import { v4 as uuid } from "uuid";

export class ScoringEngine {
  constructor(private signalStore: SignalStore) {}

  score(swap: ParsedSwap, kol: KolProfile): ScoredSignal {
    const { action, token, tokenMint, quoteMint } = classifySwapAction(swap);

    const breakdown = this.computeBreakdown(swap, kol, tokenMint);
    const conviction = this.weightedScore(breakdown);

    // Find other KOLs trading this token recently (5 min window)
    const consensusKols = this.signalStore.getRecentTokenTraders(
      tokenMint,
      300_000
    );

    const signal: ScoredSignal = {
      id: uuid(),
      kol,
      swap,
      action,
      token,
      tokenMint,
      quoteMint,
      conviction,
      breakdown,
      consensusKols,
      timestamp: swap.timestamp || Date.now(),
      expiresAt: (swap.timestamp || Date.now()) + config.signalTtlSeconds * 1000,
    };

    return signal;
  }

  private computeBreakdown(
    swap: ParsedSwap,
    kol: KolProfile,
    tokenMint: string
  ): ConvictionBreakdown {
    return {
      positionSizeScore: this.scorePositionSize(swap),
      holdHistoryScore: this.scoreHoldHistory(kol),
      historicalPnlScore: this.scoreHistoricalPnl(kol),
      rugAvoidanceScore: this.scoreRugAvoidance(kol),
      consensusScore: this.scoreConsensus(tokenMint),
    };
  }

  /**
   * Position Size Score (weight: 40%)
   * How significant is this trade relative to typical behavior?
   * Higher amounts = higher conviction signal.
   *
   * We use a logarithmic scale since whale trades vary enormously.
   * Thresholds calibrated for Solana memecoin/DeFi trades.
   */
  private scorePositionSize(swap: ParsedSwap): number {
    // Normalize to SOL-equivalent rough estimate
    // SOL mint = lamports, so divide by 1e9
    // USDC mint = 6 decimals, divide by 1e6
    let usdEstimate = 0;

    const solMint = "So11111111111111111111111111111111111111112";
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    if (swap.inputMint === solMint) {
      // Rough SOL price estimate — in production, use oracle
      const solPrice = 170; // hardcoded for MVP, replace with Pyth feed
      usdEstimate = (swap.inputAmount / 1e9) * solPrice;
    } else if (swap.inputMint === usdcMint) {
      usdEstimate = swap.inputAmount / 1e6;
    } else {
      // Unknown input token, estimate based on output
      if (swap.outputMint === solMint) {
        const solPrice = 170;
        usdEstimate = (swap.outputAmount / 1e9) * solPrice;
      } else if (swap.outputMint === usdcMint) {
        usdEstimate = swap.outputAmount / 1e6;
      } else {
        // Can't estimate — give neutral score
        return 50;
      }
    }

    // Scoring thresholds (USD value)
    if (usdEstimate >= 50_000) return 100;
    if (usdEstimate >= 20_000) return 90;
    if (usdEstimate >= 10_000) return 80;
    if (usdEstimate >= 5_000) return 70;
    if (usdEstimate >= 1_000) return 60;
    if (usdEstimate >= 500) return 50;
    if (usdEstimate >= 100) return 35;
    return 20; // dust trade
  }

  /**
   * Hold History Score (weight: 20%)
   * KOLs who hold positions longer signal more conviction.
   * Quick flippers get lower scores.
   */
  private scoreHoldHistory(kol: KolProfile): number {
    const avgHoldHours = kol.avgHoldDurationMs / 3_600_000;

    if (avgHoldHours >= 24) return 95;
    if (avgHoldHours >= 12) return 85;
    if (avgHoldHours >= 4) return 70;
    if (avgHoldHours >= 1) return 55;
    if (avgHoldHours >= 0.25) return 35; // 15 min
    return 20; // instant flipper
  }

  /**
   * Historical PnL Score (weight: 15%)
   * KOLs with better track records produce higher conviction signals.
   */
  private scoreHistoricalPnl(kol: KolProfile): number {
    const winRate = kol.historicalWinRate;
    const minTrades = 50; // need enough data to be meaningful

    if (kol.totalTrackedTrades < minTrades) {
      // Insufficient data — neutral score
      return 50;
    }

    if (winRate >= 0.70) return 95;
    if (winRate >= 0.60) return 80;
    if (winRate >= 0.50) return 60;
    if (winRate >= 0.40) return 40;
    return 25;
  }

  /**
   * Rug Avoidance Score (weight: 15%)
   * KOLs who consistently avoid rug pulls are more trustworthy.
   */
  private scoreRugAvoidance(kol: KolProfile): number {
    const rate = kol.rugAvoidanceRate;

    if (rate >= 0.95) return 100;
    if (rate >= 0.90) return 85;
    if (rate >= 0.80) return 65;
    if (rate >= 0.70) return 45;
    return 25;
  }

  /**
   * Consensus Score (weight: 10%)
   * Multiple KOLs trading the same token = stronger signal.
   */
  private scoreConsensus(tokenMint: string): number {
    const recentTraders = this.signalStore.getRecentTokenTraders(
      tokenMint,
      300_000 // 5 minute window
    );

    const count = recentTraders.length;

    if (count >= 5) return 100;
    if (count >= 4) return 90;
    if (count >= 3) return 75;
    if (count >= 2) return 55;
    return 30; // solo trade
  }

  private weightedScore(b: ConvictionBreakdown): number {
    const w = config.scoring;
    const raw =
      b.positionSizeScore * w.positionSizeWeight +
      b.holdHistoryScore * w.holdHistoryWeight +
      b.historicalPnlScore * w.historicalPnlWeight +
      b.rugAvoidanceScore * w.rugAvoidanceWeight +
      b.consensusScore * w.consensusWeight;

    return Math.round(Math.min(100, Math.max(0, raw)));
  }
}
