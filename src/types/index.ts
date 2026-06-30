// ===================================================
// Sentric — Core Types
// ===================================================

export interface KolProfile {
  address: string;
  label: string; // human-readable name e.g. "@ansem"
  tier: "s" | "a" | "b" | "c"; // quality tier
  historicalWinRate: number; // 0-1
  avgHoldDurationMs: number;
  rugAvoidanceRate: number; // 0-1
  totalTrackedTrades: number;
  addedAt: number; // timestamp

  // === X / social enrichment (optional) ===
  xHandle?: string; // real X handle, may differ from label (e.g. @ansem -> blknoiz06)
  xUserId?: string; // resolved X numeric user id
  followerCount?: number; // X follower count
  verified?: boolean; // X verified / blue check
  socialCredibility?: number; // 0-1 multiplier derived from followers + verification
}

export interface ParsedSwap {
  signature: string;
  wallet: string;
  timestamp: number;
  programId: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number; // raw lamports / token units
  outputAmount: number;
  inputSymbol?: string;
  outputSymbol?: string;
  slot: number;
}

export interface ScoredSignal {
  id: string;
  kol: KolProfile;
  swap: ParsedSwap;
  action: "BUY" | "SELL";
  token: string; // the "interesting" token (not SOL/USDC)
  tokenMint: string;
  quoteMint: string;
  conviction: number; // 0-100
  breakdown: ConvictionBreakdown;
  consensusKols: string[]; // other KOLs trading same token recently
  timestamp: number;
  expiresAt: number;
}

export interface ConvictionBreakdown {
  positionSizeScore: number; // 0-100, weight 40%
  holdHistoryScore: number; // 0-100, weight 20%
  historicalPnlScore: number; // 0-100, weight 15%
  rugAvoidanceScore: number; // 0-100, weight 15%
  consensusScore: number; // 0-100, weight 10%
}

export interface SignalQuery {
  minConviction?: number;
  tokenFilter?: string[];
  maxAge?: number; // seconds
  kolFilter?: string[];
  action?: "BUY" | "SELL";
  limit?: number;
}

export interface ConsensusQuery {
  minKols?: number;
  window?: number; // seconds
  minConviction?: number;
  limit?: number;
}

export interface ConsensusSignal {
  token: string;
  tokenMint: string;
  kols: Array<{
    label: string;
    address: string;
    conviction: number;
    action: "BUY" | "SELL";
    timestamp: number;
  }>;
  avgConviction: number;
  kolCount: number;
  firstSeen: number;
  lastSeen: number;
}

// Helius Enhanced Transaction types (subset)
export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      mint: string;
    }>;
  }>;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
        mint: string;
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
        mint: string;
      }>;
      tokenFees?: Array<any>;
      nativeFees?: Array<any>;
      innerSwaps?: Array<any>;
    };
  };
}

// x402 types
export interface PaymentTerms {
  asset: string; // USDC mint on Solana
  amount: string; // in base units
  recipient: string; // Sentric treasury wallet
  network: string; // "solana:mainnet" or "solana:devnet"
}

// ===================================================
// Social (X / Twitter) types
// ===================================================

// A token reference extracted from tweet text
export interface ExtractedToken {
  type: "contract" | "cashtag" | "link"; // how it was found
  value: string; // the mint address (for contract/link) or ticker (for cashtag)
  raw: string; // the original matched text
  mint?: string; // resolved mint address if known
}

// A single post pulled from X
export interface SocialPost {
  id: string; // tweet id
  authorHandle: string;
  authorId: string;
  text: string;
  createdAt: number; // ms timestamp
  url: string;
  extractedTokens: ExtractedToken[];
}

// X profile snapshot for a KOL
export interface SocialProfile {
  handle: string;
  userId: string;
  followers: number;
  verified: boolean;
  accountCreatedAt: number;
}

// A signal derived from a KOL's tweet — the EARLIEST possible signal
export interface SocialSignal {
  id: string;
  kolAddress: string; // links back to the on-chain KOL profile
  kolLabel: string;
  xHandle: string;
  tweetId: string;
  tweetUrl: string;
  text: string;
  tokens: ExtractedToken[]; // tokens mentioned in the tweet
  timestamp: number; // when the tweet was posted
  detectedAt: number; // when Sentric saw it
  latencyMs: number; // detectedAt - timestamp (how early we caught it)
  matchedOnChain: boolean; // did this KOL also buy one of these tokens on-chain?
  onChainSignalId?: string; // link to the confirming ScoredSignal if matched
  priority: "alpha" | "confirmed"; // alpha = tweet only, confirmed = tweet + on-chain
}
