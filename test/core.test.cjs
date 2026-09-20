const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseHeliusTransaction } = require("../dist/ingestion/parser");
const { SignalStore } = require("../dist/store/signal-store");
const { ScoringEngine } = require("../dist/scoring/engine");
const { extractTokens } = require("../dist/social/token-extractor");
const { priceOracle } = require("../dist/oracle/price");
const { config } = require("../dist/config");
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const leg = (userAccount, mint, amount, decimals = 6) => ({
  userAccount,
  mint,
  rawTokenAmount: { tokenAmount: String(amount), decimals },
});
const tx = () => ({
  signature: "synthetic",
  timestamp: Math.floor(Date.now() / 1000),
  type: "SWAP",
  slot: 1,
  events: {
    swap: {
      nativeInput: { account: "wallet", amount: "1000000000" },
      tokenOutputs: [leg("wallet", TOKEN, 3000000)],
    },
  },
});
test("parser attributes swap legs to wallet and preserves decimals", () => {
  const parsed = parseHeliusTransaction(tx(), "wallet");
  assert.equal(parsed.inputDecimals, 9);
  assert.equal(parsed.outputDecimals, 6);
  assert.equal(parsed.outputAmount, 3000000);
  assert.equal(parseHeliusTransaction(tx(), "other"), null);
});
test("failed, non-swap, ambiguous and stable-to-stable events are rejected", () => {
  const failed = tx();
  failed.transactionError = { error: "failed" };
  assert.equal(parseHeliusTransaction(failed, "wallet"), null);
  const transfer = tx();
  transfer.type = "TRANSFER";
  assert.equal(parseHeliusTransaction(transfer, "wallet"), null);
  const stable = tx();
  stable.events.swap.tokenOutputs[0].mint = USDC;
  assert.equal(parseHeliusTransaction(stable, "wallet"), null);
  const multi = tx();
  multi.events.swap.tokenOutputs.push(leg("wallet", "second", 50));
  assert.equal(parseHeliusTransaction(multi, "wallet"), null);
});
test("SPL balance fallback scans token accounts and one-token native swaps", () => {
  const data = tx();
  delete data.events;
  data.accountData = [
    {
      account: "token-account",
      tokenBalanceChanges: [leg("wallet", TOKEN, 1000)],
    },
  ];
  data.nativeTransfers = [
    { fromUserAccount: "wallet", toUserAccount: "pool", amount: 1000000000 },
  ];
  assert.equal(parseHeliusTransaction(data, "wallet").outputMint, TOKEN);
});
const signal = (id, address, action = "BUY", time = Date.now()) => ({
  id,
  kol: { address, label: address },
  action,
  token: "TOKEN",
  tokenMint: TOKEN,
  conviction: 70,
  timestamp: time,
  expiresAt: time + 300000,
});
test("store deduplicates, expires and separates opposing consensus", () => {
  const store = new SignalStore();
  try {
    const a = signal("one", "a");
    store.add(a);
    store.add(a);
    assert.equal(store.size(), 1);
    store.add(signal("two", "a"));
    store.add(signal("three", "b", "SELL"));
    assert.equal(store.getConsensus({}).length, 0);
    store.add(signal("four", "c"));
    const groups = store.getConsensus({});
    assert.equal(groups.length, 1);
    assert.equal(groups[0].action, "BUY");
    assert.equal(groups[0].kolCount, 2);
    assert.deepEqual(store.getRecentTokenTraders(TOKEN, 300000, "BUY", "a"), [
      "c",
    ]);
    store.add(signal("expired", "z", "BUY", Date.now() - 400000));
    assert.equal(
      store.query({ maxAge: 86400 }).some((s) => s.id === "expired"),
      false,
    );
  } finally {
    store.destroy();
  }
});
test("unknown historical metrics stay neutral; unknown prices are not dust", async () => {
  const store = new SignalStore();
  const scoring = new ScoringEngine(store);
  const original = priceOracle.getPrice;
  try {
    const kol = {
      address: "wallet",
      label: "watch",
      tier: "b",
      historicalWinRate: 1,
      avgHoldDurationMs: 999999999,
      rugAvoidanceRate: 1,
      totalTrackedTrades: 999,
      addedAt: 0,
      metricsSource: "unknown",
    };
    let swap = parseHeliusTransaction(tx(), "wallet");
    priceOracle.getPrice = async () => 0;
    const result = await scoring.score(swap, kol);
    assert.equal(result.breakdown.positionSizeScore, 50);
    assert.equal(result.breakdown.historicalPnlScore, 50);
    assert.equal(result.breakdown.rugAvoidanceScore, 50);
    assert.equal(result.id, "synthetic:wallet");
    priceOracle.getPrice = async () => 2;
    swap = {
      ...swap,
      inputMint: "custom-base",
      inputAmount: 1000000000,
      inputDecimals: 6,
    };
    const withDecimals = await scoring.score(swap, kol);
    assert.equal(withDecimals.breakdown.positionSizeScore, 60);
  } finally {
    priceOracle.getPrice = original;
    store.destroy();
  }
});
test("DEX pair links and lookalike hosts are not falsely resolved to mints", () => {
  assert.equal(
    extractTokens("https://dexscreener.com/solana/" + TOKEN).length,
    0,
  );
  assert.equal(extractTokens("https://evilpump.fun/coin/" + TOKEN).length, 0);
  assert.equal(extractTokens("https://pump.fun/coin/" + TOKEN)[0].mint, TOKEN);
});
