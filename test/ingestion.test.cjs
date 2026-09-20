const { test } = require("node:test");
const assert = require("node:assert/strict");
const { IngestionEngine } = require("../dist/ingestion/engine");
const { KolStore } = require("../dist/config/kols");
const { SignalStore } = require("../dist/store/signal-store");
const { ScoringEngine } = require("../dist/scoring/engine");
const { config } = require("../dist/config");
test("WebSocket hydration calls Enhanced API and ingests each wallet/transaction once", async () => {
  const original = global.fetch;
  const wallets = new KolStore();
  const store = new SignalStore();
  const scoring = new ScoringEngine(store);
  const engine = new IngestionEngine(wallets, scoring, store);
  const wallet = wallets.getAll()[0].address;
  const tx = {
    signature: "synthetic-tx",
    timestamp: Math.floor(Date.now() / 1000),
    type: "SWAP",
    source: "JUPITER",
    slot: 123,
    events: {
      swap: {
        tokenInputs: [
          {
            userAccount: wallet,
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 },
          },
        ],
        tokenOutputs: [
          {
            userAccount: wallet,
            mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
            rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
          },
        ],
      },
    },
  };
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.match(String(url), /\/v0\/transactions\?/);
    assert.deepEqual(JSON.parse(options.body), {
      transactions: ["synthetic-tx"],
    });
    return new Response(JSON.stringify([tx]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    engine.running = true;
    await engine.hydrate("synthetic-tx");
    assert.equal(store.size(), 1);
    await engine.hydrate("synthetic-tx");
    assert.equal(store.size(), 1);
    assert.equal(calls, 2);
    assert.ok(engine.getStatus().lastSuccessAt);
    assert.equal(store.query({})[0].swap.outputDecimals, 6);
  } finally {
    global.fetch = original;
    engine.stop();
    store.destroy();
  }
});
