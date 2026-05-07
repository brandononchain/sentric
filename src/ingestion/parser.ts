import { HeliusTransaction, ParsedSwap } from "../types";
import { config } from "../config";

// Well-known program IDs for DEX protocols
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_V4 = "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const DEX_PROGRAMS = new Set([
  JUPITER_V6,
  JUPITER_V4,
  RAYDIUM_AMM,
  RAYDIUM_CLMM,
  ORCA_WHIRLPOOL,
  METEORA_DLMM,
]);

// Known token symbols for display
const KNOWN_TOKENS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "SOL",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "POPCAT",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7: "DRIFT",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RENDER",
};

export function parseHeliusTransaction(
  tx: HeliusTransaction,
  watchedWallet: string
): ParsedSwap | null {
  // Strategy 1: Use Helius swap event (most reliable)
  if (tx.events?.swap) {
    return parseSwapEvent(tx, watchedWallet);
  }

  // Strategy 2: Parse token balance changes for the wallet
  return parseFromBalanceChanges(tx, watchedWallet);
}

function parseSwapEvent(
  tx: HeliusTransaction,
  wallet: string
): ParsedSwap | null {
  const swap = tx.events!.swap!;

  let inputMint = "";
  let outputMint = "";
  let inputAmount = 0;
  let outputAmount = 0;

  // Handle native SOL input
  if (swap.nativeInput && parseInt(swap.nativeInput.amount) > 0) {
    inputMint = "So11111111111111111111111111111111111111112";
    inputAmount = parseInt(swap.nativeInput.amount);
  }

  // Handle token inputs
  if (swap.tokenInputs && swap.tokenInputs.length > 0) {
    const tokenIn = swap.tokenInputs[0];
    inputMint = tokenIn.mint;
    inputAmount = parseInt(tokenIn.rawTokenAmount.tokenAmount);
  }

  // Handle native SOL output
  if (swap.nativeOutput && parseInt(swap.nativeOutput.amount) > 0) {
    outputMint = "So11111111111111111111111111111111111111112";
    outputAmount = parseInt(swap.nativeOutput.amount);
  }

  // Handle token outputs
  if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
    const tokenOut = swap.tokenOutputs[0];
    outputMint = tokenOut.mint;
    outputAmount = parseInt(tokenOut.rawTokenAmount.tokenAmount);
  }

  if (!inputMint || !outputMint) return null;

  return {
    signature: tx.signature,
    wallet,
    timestamp: tx.timestamp * 1000,
    programId: tx.source || JUPITER_V6,
    inputMint,
    outputMint,
    inputAmount,
    outputAmount,
    inputSymbol: KNOWN_TOKENS[inputMint] || inputMint.slice(0, 6),
    outputSymbol: KNOWN_TOKENS[outputMint] || outputMint.slice(0, 6),
    slot: tx.slot,
  };
}

function parseFromBalanceChanges(
  tx: HeliusTransaction,
  wallet: string
): ParsedSwap | null {
  // Find the account data for our watched wallet
  const walletData = tx.accountData?.find((a) => a.account === wallet);
  if (!walletData) return null;

  const changes = walletData.tokenBalanceChanges;
  if (!changes || changes.length < 2) return null;

  // Find what went out (negative) and what came in (positive)
  let inputMint = "";
  let outputMint = "";
  let inputAmount = 0;
  let outputAmount = 0;

  for (const change of changes) {
    const amount = parseInt(change.rawTokenAmount.tokenAmount);
    if (amount < 0) {
      inputMint = change.mint;
      inputAmount = Math.abs(amount);
    } else if (amount > 0) {
      outputMint = change.mint;
      outputAmount = amount;
    }
  }

  // Also check native SOL balance change
  if (walletData.nativeBalanceChange !== 0) {
    const solMint = "So11111111111111111111111111111111111111112";
    if (walletData.nativeBalanceChange < 0 && !inputMint) {
      inputMint = solMint;
      inputAmount = Math.abs(walletData.nativeBalanceChange);
    } else if (walletData.nativeBalanceChange > 0 && !outputMint) {
      outputMint = solMint;
      outputAmount = walletData.nativeBalanceChange;
    }
  }

  if (!inputMint || !outputMint) return null;

  return {
    signature: tx.signature,
    wallet,
    timestamp: tx.timestamp * 1000,
    programId: tx.source || "unknown",
    inputMint,
    outputMint,
    inputAmount,
    outputAmount,
    inputSymbol: KNOWN_TOKENS[inputMint] || inputMint.slice(0, 6),
    outputSymbol: KNOWN_TOKENS[outputMint] || outputMint.slice(0, 6),
    slot: tx.slot,
  };
}

/**
 * Determine if this is a BUY or SELL of a non-stable token.
 * BUY = spending SOL/USDC/stables to acquire a token
 * SELL = spending a token to acquire SOL/USDC/stables
 */
export function classifySwapAction(
  swap: ParsedSwap
): { action: "BUY" | "SELL"; token: string; tokenMint: string; quoteMint: string } {
  const inputIsStable = config.stableAndBaseMints.has(swap.inputMint);
  const outputIsStable = config.stableAndBaseMints.has(swap.outputMint);

  if (inputIsStable && !outputIsStable) {
    // Spending stables to get a token = BUY
    return {
      action: "BUY",
      token: swap.outputSymbol || swap.outputMint.slice(0, 6),
      tokenMint: swap.outputMint,
      quoteMint: swap.inputMint,
    };
  }

  if (!inputIsStable && outputIsStable) {
    // Selling a token for stables = SELL
    return {
      action: "SELL",
      token: swap.inputSymbol || swap.inputMint.slice(0, 6),
      tokenMint: swap.inputMint,
      quoteMint: swap.outputMint,
    };
  }

  // Both non-stable or both stable — classify by convention
  // Treat input as the token being sold
  return {
    action: "BUY",
    token: swap.outputSymbol || swap.outputMint.slice(0, 6),
    tokenMint: swap.outputMint,
    quoteMint: swap.inputMint,
  };
}
