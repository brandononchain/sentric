export class SentricApiError extends Error {
  constructor(
    public status: number,
    public details: unknown,
  ) {
    super(`Sentric API returned ${status}`);
  }
}
/** Inject an x402-enabled fetch for paid access; ordinary fetch never spends funds. */
export class SentricClient {
  private base: string;
  constructor(
    baseUrl = "http://127.0.0.1:3000",
    private transport: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Sentric URL");
    this.base = url.toString().replace(/\/$/, "");
  }
  async get(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.transport(url, {
      signal: AbortSignal.timeout(30000),
      headers: { Accept: "application/json" },
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new SentricApiError(response.status, data);
    return data;
  }
  health() {
    return this.get("/health");
  }
  wallets() {
    return this.get("/v1/kols");
  }
  preview() {
    return this.get("/v1/signals/preview");
  }
  signals(query: Record<string, string | number | undefined> = {}) {
    return this.get("/v1/signals", query);
  }
  consensus(query: Record<string, string | number | undefined> = {}) {
    return this.get("/v1/signals/consensus", query);
  }
}
