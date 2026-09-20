import { config } from "../config";
const SOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Jupiter v3. Zero means unavailable, never proof of a worthless token. */
class PriceOracle {
  private cache = new Map<string, { price: number; fetchedAt: number }>();
  private pending = new Map<string, Promise<number>>();
  async getPrice(mint: string): Promise<number> {
    if (STABLES.has(mint)) return 1; // nominal quote valuation, not a depeg oracle
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < 30_000) return cached.price;
    if (!config.jupiterApiKey) return 0;
    if (this.pending.has(mint)) return this.pending.get(mint)!;
    const request = this.fetchPrice(mint);
    this.pending.set(mint, request);
    try {
      return await request;
    } finally {
      this.pending.delete(mint);
    }
  }
  private async fetchPrice(mint: string): Promise<number> {
    let price = 0;
    try {
      const response = await fetch(
        `https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`,
        {
          headers: { "x-api-key": config.jupiterApiKey },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as Record<
          string,
          { usdPrice?: number }
        >;
        const value = Number(data[mint]?.usdPrice);
        if (Number.isFinite(value) && value > 0) price = value;
      }
    } catch {
      /* Unavailable prices contribute a neutral score. */
    }
    if (this.cache.size >= 5000)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(mint, { price, fetchedAt: Date.now() });
    return price;
  }
  getSolPrice() {
    return this.getPrice(SOL);
  }
  async getPrices(mints: string[]) {
    const result = new Map<string, number>();
    for (const mint of new Set(mints))
      result.set(mint, await this.getPrice(mint));
    return result;
  }
  async toUsd(mint: string, rawAmount: number, decimals?: number) {
    const precision =
      decimals ?? (mint === SOL ? 9 : STABLES.has(mint) ? 6 : undefined);
    if (precision === undefined) return 0;
    return (rawAmount / 10 ** precision) * (await this.getPrice(mint));
  }
  getCacheSize() {
    return this.cache.size;
  }
}
export const priceOracle = new PriceOracle();
