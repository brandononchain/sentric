// Run the API in local development mode first. This example never signs or trades.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SentricClient } = require("../dist/agent/client.js");
const client = new SentricClient(
  process.env.SENTRIC_API_URL || "http://127.0.0.1:3000",
);
const health = await client.health();
if (!health.ingestion.enabled || health.ingestion.stale) {
  console.log(
    JSON.stringify(
      {
        decision: "wait",
        reason: "Live ingestion is unavailable or stale",
        health,
      },
      null,
      2,
    ),
  );
} else {
  const { signals } = await client.signals({
    action: "BUY",
    minConviction: 60,
    maxAge: 60,
    limit: 5,
  });
  const { consensus } = await client.consensus({ minKols: 2, window: 60 });
  const candidates = signals.filter((s) =>
    consensus.some((c) => c.tokenMint === s.tokenMint && c.action === s.action),
  );
  console.log(
    JSON.stringify(
      {
        decision: candidates.length ? "review" : "wait",
        candidates,
        note: "Research candidates only. Apply liquidity, attribution and position-risk checks independently.",
      },
      null,
      2,
    ),
  );
}
