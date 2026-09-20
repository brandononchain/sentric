import { HeliusTransaction, ParsedSwap } from "../types";
import { config } from "../config";

const SOL = "So11111111111111111111111111111111111111112";
const SYMBOLS: Record<string, string> = {
  [SOL]: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

/** Parse only successful swaps attributable to the watched wallet.
 * Ambiguous multi-asset and token-to-token routes are intentionally excluded.
 * Amounts remain raw units; decimals travel with them for valuation.
 */
export function parseHeliusTransaction(
  tx: HeliusTransaction,
  wallet: string,
): ParsedSwap | null {
  if (
    tx.transactionError ||
    tx.type !== "SWAP" ||
    !tx.signature ||
    !Number.isFinite(tx.timestamp)
  )
    return null;
  type Leg = { mint: string; amount: number; decimals: number };
  let inputs: Leg[] = [],
    outputs: Leg[] = [];
  const event = tx.events?.swap;
  if (event) {
    if (event.nativeInput?.account === wallet)
      inputs.push({
        mint: SOL,
        amount: Number(event.nativeInput.amount),
        decimals: 9,
      });
    if (event.nativeOutput?.account === wallet)
      outputs.push({
        mint: SOL,
        amount: Number(event.nativeOutput.amount),
        decimals: 9,
      });
    for (const leg of event.tokenInputs || []) {
      if (leg.userAccount === wallet)
        inputs.push({
          mint: leg.mint,
          amount: Number(leg.rawTokenAmount.tokenAmount),
          decimals: leg.rawTokenAmount.decimals,
        });
    }
    for (const leg of event.tokenOutputs || []) {
      if (leg.userAccount === wallet)
        outputs.push({
          mint: leg.mint,
          amount: Number(leg.rawTokenAmount.tokenAmount),
          decimals: leg.rawTokenAmount.decimals,
        });
    }
  } else {
    // SPL balance changes usually live under token accounts, not the wallet account.
    const changes = new Map<string, Leg>();
    for (const account of tx.accountData || []) {
      for (const change of account.tokenBalanceChanges || []) {
        if (change.userAccount !== wallet) continue;
        const previous = changes.get(change.mint);
        changes.set(change.mint, {
          mint: change.mint,
          amount:
            (previous?.amount || 0) + Number(change.rawTokenAmount.tokenAmount),
          decimals: change.rawTokenAmount.decimals,
        });
      }
    }
    for (const change of changes.values()) {
      if (change.amount < 0) inputs.push({ ...change, amount: -change.amount });
      if (change.amount > 0) outputs.push(change);
    }
    // Native transfers exclude the fee/rent-only balance deltas that can mimic buys.
    const nativeDelta = (tx.nativeTransfers || []).reduce(
      (sum, t) =>
        sum +
        (t.toUserAccount === wallet ? t.amount : 0) -
        (t.fromUserAccount === wallet ? t.amount : 0),
      0,
    );
    if (nativeDelta < 0 && inputs.length === 0)
      inputs.push({ mint: SOL, amount: -nativeDelta, decimals: 9 });
    if (nativeDelta > 0 && outputs.length === 0)
      outputs.push({ mint: SOL, amount: nativeDelta, decimals: 9 });
  }
  const combine = (legs: Leg[]) => {
    const grouped = new Map<string, Leg>();
    for (const leg of legs)
      grouped.set(leg.mint, {
        ...leg,
        amount: (grouped.get(leg.mint)?.amount || 0) + leg.amount,
      });
    return [...grouped.values()];
  };
  inputs = combine(inputs);
  outputs = combine(outputs);
  if (inputs.length !== 1 || outputs.length !== 1) return null;
  const input = inputs[0],
    output = outputs[0];
  if (
    ![input, output].every(
      (l) =>
        Number.isFinite(l.amount) &&
        l.amount > 0 &&
        Number.isInteger(l.decimals) &&
        l.decimals >= 0 &&
        l.decimals <= 18,
    )
  )
    return null;
  if (
    config.stableAndBaseMints.has(input.mint) ===
    config.stableAndBaseMints.has(output.mint)
  )
    return null;
  return {
    signature: tx.signature,
    wallet,
    timestamp: tx.timestamp * 1000,
    programId: tx.source || "unknown",
    inputMint: input.mint,
    outputMint: output.mint,
    inputAmount: input.amount,
    outputAmount: output.amount,
    inputDecimals: input.decimals,
    outputDecimals: output.decimals,
    inputSymbol: SYMBOLS[input.mint] || input.mint.slice(0, 6),
    outputSymbol: SYMBOLS[output.mint] || output.mint.slice(0, 6),
    slot: tx.slot,
  };
}

export function classifySwapAction(swap: ParsedSwap): {
  action: "BUY" | "SELL";
  token: string;
  tokenMint: string;
  quoteMint: string;
} {
  const buy = config.stableAndBaseMints.has(swap.inputMint);
  return {
    action: buy ? "BUY" : "SELL",
    token:
      (buy ? swap.outputSymbol : swap.inputSymbol) ||
      (buy ? swap.outputMint : swap.inputMint).slice(0, 6),
    tokenMint: buy ? swap.outputMint : swap.inputMint,
    quoteMint: buy ? swap.inputMint : swap.outputMint,
  };
}
