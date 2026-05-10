/**
 * Live Price Oracle
 * 
 * Fetches real-time token prices from Jupiter Price API (free, no key required).
 * Caches prices for 30 seconds to avoid rate limiting.
 * Used by the scoring engine for accurate position size calculations.
 */

const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";
const CACHE_TTL_MS = 30_000; // 30 seconds

// Well-known mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

interface PriceCache {
  price: number;
  fetchedAt: number;
}

class PriceOracle {
  private cache = new Map<string, PriceCache>();
  private pendingFetches = new Map<string, Promise<number>>();

  /**
   * Get the USD price of a token mint.
   * Returns 0 if price cannot be determined.
   */
  async getPrice(mint: string): Promise<number> {
    // USDC and USDT are always $1
    if (mint === USDC_MINT || mint === USDT_MINT) return 1;

    // Check cache
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.price;
    }

    // Deduplicate in-flight requests for the same mint
    const pending = this.pendingFetches.get(mint);
    if (pending) return pending;

    const fetchPromise = this.fetchPrice(mint);
    this.pendingFetches.set(mint, fetchPromise);

    try {
      const price = await fetchPromise;
      return price;
    } finally {
      this.pendingFetches.delete(mint);
    }
  }

  /**
   * Get SOL price in USD. Convenience method.
   */
  async getSolPrice(): Promise<number> {
    return this.getPrice(SOL_MINT);
  }

  /**
   * Batch fetch prices for multiple mints at once.
   * Jupiter supports comma-separated mint lists.
   */
  async getPrices(mints: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    const toFetch: string[] = [];

    for (const mint of mints) {
      if (mint === USDC_MINT || mint === USDT_MINT) {
        results.set(mint, 1);
        continue;
      }

      const cached = this.cache.get(mint);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        results.set(mint, cached.price);
        continue;
      }

      toFetch.push(mint);
    }

    if (toFetch.length > 0) {
      try {
        // Jupiter supports up to 100 mints per request
        for (let i = 0; i < toFetch.length; i += 100) {
          const batch = toFetch.slice(i, i + 100);
          const ids = batch.join(",");
          const response = await fetch(`${JUPITER_PRICE_API}?ids=${ids}`);

          if (response.ok) {
            const data = await response.json() as any;
            if (data.data) {
              for (const mint of batch) {
                const priceData = data.data[mint];
                const price = priceData?.price ? parseFloat(priceData.price) : 0;
                results.set(mint, price);
                this.cache.set(mint, { price, fetchedAt: Date.now() });
              }
            }
          }
        }
      } catch (err) {
        console.warn("[ORACLE] Jupiter price fetch failed:", err);
      }
    }

    // Fill in any missing with 0
    for (const mint of mints) {
      if (!results.has(mint)) results.set(mint, 0);
    }

    return results;
  }

  private async fetchPrice(mint: string): Promise<number> {
    try {
      const response = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`);
      if (!response.ok) return 0;

      const data = await response.json() as any;
      const price = data?.data?.[mint]?.price ? parseFloat(data.data[mint].price) : 0;

      this.cache.set(mint, { price, fetchedAt: Date.now() });
      return price;
    } catch (err) {
      console.warn(`[ORACLE] Failed to fetch price for ${mint.slice(0, 8)}:`, err);
      return 0;
    }
  }

  /**
   * Convert a raw token amount to USD value.
   * Handles SOL (9 decimals), USDC (6 decimals), and arbitrary SPL tokens.
   */
  async toUsd(mint: string, rawAmount: number): Promise<number> {
    const price = await this.getPrice(mint);
    if (price === 0) return 0;

    let decimals = 9; // default for SOL
    if (mint === USDC_MINT || mint === USDT_MINT) decimals = 6;
    // For other tokens, Jupiter returns prices in terms of 1 full token
    // so we need to know decimals. Default to 9 for Solana tokens,
    // but this is approximate for non-SOL tokens.

    const amount = rawAmount / Math.pow(10, decimals);
    return amount * price;
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

// Singleton
export const priceOracle = new PriceOracle();
