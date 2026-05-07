// ===================================================
// SENTRY Protocol — Core Types
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
  recipient: string; // SENTRY treasury wallet
  network: string; // "solana:mainnet" or "solana:devnet"
}
