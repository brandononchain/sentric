import { v4 as uuid } from "uuid";
import { config } from "../config";
import { KolStore } from "../config/kols";
import { SignalStore } from "../store/signal-store";
import { SocialProvider, createSocialProvider } from "./x-client";
import { labelToXHandle } from "./handle-map";
import { SocialSignal, SocialProfile, KolProfile } from "../types";

/**
 * X Monitor
 *
 * Polls KOL X timelines for the EARLIEST possible signal — a tweet naming a
 * token. The moment a tracked KOL tweets a contract address, cashtag, or DEX
 * link, we emit a social signal. If that same KOL also bought the token
 * on-chain (cross-referenced against the live signal store), the signal is
 * upgraded to "confirmed" — the highest-conviction state in the system.
 *
 * Polling is TIERED to control cost:
 *   - S-tier (Ansem etc): polled every SOCIAL_FAST_POLL_MS  (default 15s)
 *   - A-tier:             polled every SOCIAL_MID_POLL_MS   (default 60s)
 *   - B/C-tier:           polled every SOCIAL_SLOW_POLL_MS  (default 300s)
 *
 * This focuses spend on the wallets that actually move markets.
 */

const MAX_SOCIAL_SIGNALS = 500;
const SOCIAL_SIGNAL_TTL_MS = 60 * 60 * 1000; // 1h

interface MonitoredKol {
  kol: KolProfile;
  xHandle: string;
  xUserId: string | null;
  lastTweetId: string | null;
  nextPollAt: number;
  pollIntervalMs: number;
}

export class XMonitor {
  private provider: SocialProvider;
  private providerName: string;
  private monitored: Map<string, MonitoredKol> = new Map();
  private socialSignals: SocialSignal[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private kolStore: KolStore,
    private signalStore: SignalStore
  ) {
    const { provider, name } = createSocialProvider();
    this.provider = provider;
    this.providerName = name;
  }

  isEnabled(): boolean {
    return this.providerName !== "none";
  }

  getProviderName(): string {
    return this.providerName;
  }

  /**
   * Resolve handles -> user IDs, fetch profiles, enrich KOL credibility,
   * then begin the polling loop.
   */
  async start(): Promise<void> {
    if (!this.isEnabled()) {
      console.log("[X-MONITOR] No social provider configured — disabled");
      return;
    }
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[X-MONITOR] Starting with provider: ${this.providerName}`);

    // Build the monitored set with tiered poll intervals
    await this.initMonitoredKols();

    // Tick every 5s; each tick polls whichever KOLs are due
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("[X-MONITOR] Tick failed:", err));
    }, 5000);

    console.log(`[X-MONITOR] Monitoring ${this.monitored.size} KOL timelines`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[X-MONITOR] Stopped");
  }

  private async initMonitoredKols(): Promise<void> {
    const fastMs = config.socialFastPollMs;
    const midMs = config.socialMidPollMs;
    const slowMs = config.socialSlowPollMs;

    for (const kol of this.kolStore.getAll()) {
      const xHandle = kol.xHandle || labelToXHandle(kol.label);

      // Tiered polling interval
      let interval = slowMs;
      if (kol.tier === "s") interval = fastMs;
      else if (kol.tier === "a") interval = midMs;

      this.monitored.set(kol.address, {
        kol,
        xHandle,
        xUserId: kol.xUserId || null,
        lastTweetId: null,
        nextPollAt: 0, // poll on first tick
        pollIntervalMs: interval,
      });
    }

    // Resolve user IDs + enrich profiles for S/A tier only (cost control).
    // B/C tier resolve lazily on first poll.
    const priority = Array.from(this.monitored.values()).filter(
      (m) => m.kol.tier === "s" || m.kol.tier === "a"
    );

    for (const m of priority) {
      try {
        const profile = await this.provider.getProfile(m.xHandle);
        if (profile) {
          m.xUserId = profile.userId;
          this.enrichKol(m.kol, profile);
        }
        await this.sleep(300); // rate limit
      } catch {
        // skip
      }
    }
  }

  /**
   * Apply X profile data to the KOL — followers, verification, credibility.
   */
  private enrichKol(kol: KolProfile, profile: SocialProfile): void {
    kol.xHandle = profile.handle;
    kol.xUserId = profile.userId;
    kol.followerCount = profile.followers;
    kol.verified = profile.verified;

    // Credibility multiplier: log-scaled followers + verification bonus
    // 10k followers ~ 0.4, 100k ~ 0.6, 1M ~ 0.8, +0.15 if verified, capped 1.0
    const followerScore = profile.followers > 0
      ? Math.min(0.8, Math.log10(profile.followers) / 7.5)
      : 0;
    const verifiedBonus = profile.verified ? 0.15 : 0;
    kol.socialCredibility = Math.min(1, followerScore + verifiedBonus);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = Array.from(this.monitored.values()).filter(
      (m) => m.nextPollAt <= now
    );

    // Poll at most a few per tick to spread out rate limit usage
    const batch = due.slice(0, 5);

    for (const m of batch) {
      await this.pollKol(m);
      m.nextPollAt = now + m.pollIntervalMs;
    }
  }

  private async pollKol(m: MonitoredKol): Promise<void> {
    // Resolve user id lazily if needed
    if (!m.xUserId) {
      m.xUserId = await this.provider.resolveHandle(m.xHandle);
      if (!m.xUserId) return;
    }

    const posts = await this.provider.getRecentPosts(
      m.xUserId,
      m.lastTweetId || undefined
    );
    if (posts.length === 0) return;

    // Newest first — update cursor
    m.lastTweetId = posts[0].id;

    for (const post of posts) {
      if (post.extractedTokens.length === 0) continue;

      // Cross-reference with on-chain: did this KOL buy any of these tokens?
      const onChain = this.findOnChainMatch(m.kol.address, post.extractedTokens);

      const detectedAt = Date.now();
      const signal: SocialSignal = {
        id: uuid(),
        kolAddress: m.kol.address,
        kolLabel: m.kol.label,
        xHandle: m.xHandle,
        tweetId: post.id,
        tweetUrl: post.url,
        text: post.text,
        tokens: post.extractedTokens,
        timestamp: post.createdAt,
        detectedAt,
        latencyMs: detectedAt - post.createdAt,
        matchedOnChain: !!onChain,
        onChainSignalId: onChain || undefined,
        priority: onChain ? "confirmed" : "alpha",
      };

      this.addSocialSignal(signal);

      const tokenStr = post.extractedTokens
        .map((t) => (t.type === "cashtag" ? "$" + t.value : t.value.slice(0, 8)))
        .join(", ");
      console.log(
        `[X-MONITOR] ${signal.priority.toUpperCase()} — ${m.kol.label} tweeted: ${tokenStr}` +
        (onChain ? " [matched on-chain buy]" : "")
      );
    }
  }

  /**
   * Check the on-chain signal store for a recent BUY by this KOL of any of
   * the extracted tokens (10 min window).
   */
  private findOnChainMatch(
    kolAddress: string,
    tokens: { mint?: string }[]
  ): string | null {
    const mints = tokens.map((t) => t.mint).filter(Boolean) as string[];
    if (mints.length === 0) return null;

    const recent = this.signalStore.getAll();
    const tenMinAgo = Date.now() - 10 * 60 * 1000;

    for (const sig of recent) {
      if (sig.timestamp < tenMinAgo) continue;
      if (sig.kol.address !== kolAddress) continue;
      if (sig.action !== "BUY") continue;
      if (mints.includes(sig.tokenMint)) {
        return sig.id;
      }
    }
    return null;
  }

  private addSocialSignal(signal: SocialSignal): void {
    this.socialSignals.unshift(signal);
    // Trim
    if (this.socialSignals.length > MAX_SOCIAL_SIGNALS) {
      this.socialSignals = this.socialSignals.slice(0, MAX_SOCIAL_SIGNALS);
    }
  }

  /**
   * Get recent social signals, newest first, optionally filtered.
   */
  getSocialSignals(opts?: {
    priority?: "alpha" | "confirmed";
    limit?: number;
  }): SocialSignal[] {
    const now = Date.now();
    let signals = this.socialSignals.filter(
      (s) => now - s.detectedAt < SOCIAL_SIGNAL_TTL_MS
    );

    if (opts?.priority) {
      signals = signals.filter((s) => s.priority === opts.priority);
    }

    const limit = opts?.limit || 50;
    return signals.slice(0, limit);
  }

  getStats(): { provider: string; monitored: number; signals: number } {
    return {
      provider: this.providerName,
      monitored: this.monitored.size,
      signals: this.socialSignals.length,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
