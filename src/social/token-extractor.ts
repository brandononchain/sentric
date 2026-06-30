import { ExtractedToken } from "../types";

/**
 * Token Extractor
 *
 * Parses raw tweet text for token references that a KOL might be shilling:
 *   1. Solana contract addresses (base58, 32-44 chars)
 *   2. $CASHTAGS (e.g. $POPCAT, $WIF)
 *   3. DEX / chart links (pump.fun, dexscreener, birdeye, jup.ag, solscan)
 *      — the mint is extracted straight from the URL path
 *
 * The contract address case is the highest-value: when a KOL posts a raw CA,
 * that is almost always the earliest possible buy signal — followers copy it
 * within seconds.
 */

// Base58 alphabet (no 0, O, I, l). Solana addresses are 32-44 chars.
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
const CA_REGEX = new RegExp(`\\b${BASE58}{32,44}\\b`, "g");

// $TICKER cashtags — 2 to 10 uppercase alphanumerics
const CASHTAG_REGEX = /\$([A-Z][A-Z0-9]{1,9})\b/g;

// DEX / chart URLs that embed a mint in the path
const LINK_PATTERNS: Array<{ host: RegExp; extract: (url: string) => string | null }> = [
  {
    // pump.fun/coin/<mint>  or  pump.fun/<mint>
    host: /pump\.fun/i,
    extract: (url) => {
      const m = url.match(new RegExp(`pump\\.fun/(?:coin/)?(${BASE58}{32,44})`, "i"));
      return m ? m[1] : null;
    },
  },
  {
    // dexscreener.com/solana/<pairOrMint>
    host: /dexscreener\.com/i,
    extract: (url) => {
      const m = url.match(new RegExp(`dexscreener\\.com/solana/(${BASE58}{32,44})`, "i"));
      return m ? m[1] : null;
    },
  },
  {
    // birdeye.so/token/<mint>
    host: /birdeye\.so/i,
    extract: (url) => {
      const m = url.match(new RegExp(`birdeye\\.so/token/(${BASE58}{32,44})`, "i"));
      return m ? m[1] : null;
    },
  },
  {
    // jup.ag/swap/SOL-<mint>  or  jup.ag/tokens/<mint>
    host: /jup\.ag/i,
    extract: (url) => {
      const m = url.match(new RegExp(`jup\\.ag/(?:swap/[^-]+-|tokens/)(${BASE58}{32,44})`, "i"));
      return m ? m[1] : null;
    },
  },
  {
    // solscan.io/token/<mint>
    host: /solscan\.io/i,
    extract: (url) => {
      const m = url.match(new RegExp(`solscan\\.io/token/(${BASE58}{32,44})`, "i"));
      return m ? m[1] : null;
    },
  },
];

// Things that look like base58 CAs but aren't tokens — filter these out.
// Mostly other Solana addresses we never want to treat as a "buy this" signal.
const KNOWN_NON_TOKENS = new Set<string>([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter program
]);

// URL detector
const URL_REGEX = /https?:\/\/[^\s]+/gi;

export function extractTokens(text: string): ExtractedToken[] {
  const found: ExtractedToken[] = [];
  const seen = new Set<string>();

  // 1. Links first (highest confidence — explicit chart/buy link)
  const urls = text.match(URL_REGEX) || [];
  for (const url of urls) {
    for (const pattern of LINK_PATTERNS) {
      if (pattern.host.test(url)) {
        const mint = pattern.extract(url);
        if (mint && !KNOWN_NON_TOKENS.has(mint) && !seen.has(mint)) {
          seen.add(mint);
          found.push({ type: "link", value: mint, raw: url, mint });
        }
      }
    }
  }

  // 2. Raw contract addresses in the text body
  //    Strip URLs first so we don't double-count mints embedded in links.
  const textNoUrls = text.replace(URL_REGEX, " ");
  const caMatches = textNoUrls.match(CA_REGEX) || [];
  for (const ca of caMatches) {
    if (KNOWN_NON_TOKENS.has(ca) || seen.has(ca)) continue;
    // Heuristic: a valid mint is 43-44 chars almost always. 32-42 char
    // base58 strings are often transaction sigs or noise — keep but flag.
    if (ca.length < 32) continue;
    seen.add(ca);
    found.push({ type: "contract", value: ca, raw: ca, mint: ca });
  }

  // 3. Cashtags ($POPCAT) — lower confidence, no mint resolved
  let m: RegExpExecArray | null;
  CASHTAG_REGEX.lastIndex = 0;
  while ((m = CASHTAG_REGEX.exec(text)) !== null) {
    const ticker = m[1];
    const key = "$" + ticker;
    if (seen.has(key)) continue;
    // Skip common non-token cashtags
    if (["USD", "USDC", "USDT", "SOL", "BTC", "ETH"].includes(ticker)) continue;
    seen.add(key);
    found.push({ type: "cashtag", value: ticker, raw: m[0] });
  }

  return found;
}

/**
 * Does this tweet contain any actionable token reference?
 */
export function hasTokenSignal(text: string): boolean {
  return extractTokens(text).length > 0;
}
