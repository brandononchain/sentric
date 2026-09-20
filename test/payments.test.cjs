const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
process.env.SENTRIC_DEV_MODE = "false";
process.env.HELIUS_API_KEY = "";
const { config } = require("../dist/config");
const { createApp } = require("../dist/api/server");
const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const treasury = "So11111111111111111111111111111111111111112";
test("official x402 middleware requests terms, rejects fabricated proofs, settles verified requests", async () => {
  let verifies = 0,
    settles = 0;
  const consumed = new Set();
  const facilitator = express();
  facilitator.use(express.json());
  facilitator.get("/supported", (_req, res) =>
    res.json({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network,
          extra: { feePayer: treasury },
        },
      ],
      extensions: [],
      signers: { [network]: [treasury] },
    }),
  );
  facilitator.post("/verify", (req, res) => {
    verifies++;
    const tx = req.body.paymentPayload?.payload?.transaction;
    res.json(
      tx === "synthetic-valid" && !consumed.has(tx)
        ? { isValid: true, payer: treasury }
        : { isValid: false, invalidReason: "invalid_transaction" },
    );
  });
  facilitator.post("/settle", (req, res) => {
    settles++;
    const tx = req.body.paymentPayload?.payload?.transaction;
    if (consumed.has(tx))
      return res.json({
        success: false,
        errorReason: "replay",
        transaction: "",
        network,
      });
    consumed.add(tx);
    res.json({
      success: true,
      transaction: "synthetic-settlement",
      network,
      payer: treasury,
    });
  });
  const f = facilitator.listen(0, "127.0.0.1");
  await new Promise((r) => f.once("listening", r));
  config.facilitatorUrl = `http://127.0.0.1:${f.address().port}`;
  config.treasuryWallet = treasury;
  config.paymentNetwork = network;
  const runtime = createApp();
  const http = runtime.app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const url = `http://127.0.0.1:${http.address().port}/v1/signals`;
  try {
    assert.equal((await fetch(url)).status, 503);
    assert.equal(verifies, 0);
    runtime.ingestionEngine.getStatus = () => ({
      enabled: true,
      running: true,
      stale: false,
    });
    assert.equal((await fetch(url + "?limit=-1")).status, 400);
    assert.equal(verifies, 0);
    let response = await fetch(url);
    assert.equal(response.status, 402);
    assert.ok(response.headers.get("payment-required"));
    const terms = JSON.parse(
      Buffer.from(
        response.headers.get("payment-required"),
        "base64",
      ).toString(),
    );
    assert.equal(terms.accepts[0].amount, "1000");
    assert.equal(terms.accepts[0].network, network);
    assert.equal(terms.accepts[0].payTo, treasury);
    response = await fetch(url, {
      headers: { "x-payment": "sentric-landing-page-preview" },
    });
    assert.equal(response.status, 402);
    assert.equal(settles, 0);
    response = await fetch(url, {
      headers: { "payment-signature": "forged-proof" },
    });
    assert.equal(response.status, 402);
    assert.equal(settles, 0);
    const payload = {
      x402Version: 2,
      resource: terms.resource,
      accepted: terms.accepts[0],
      payload: { transaction: "synthetic-valid" },
    };
    const headers = {
      "payment-signature": Buffer.from(JSON.stringify(payload)).toString(
        "base64",
      ),
    };
    response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("payment-response"));
    assert.equal(settles, 1);
    response = await fetch(url, { headers });
    assert.equal(response.status, 402);
    assert.equal(settles, 1);
  } finally {
    runtime.close();
    http.close();
    f.close();
  }
});
