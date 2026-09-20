const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.SENTRIC_DEV_MODE = "true";
process.env.HELIUS_API_KEY = "";
process.env.ADMIN_API_KEY = "test-admin-token";
const { createApp } = require("../dist/api/server");
const { config } = require("../dist/config");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { KolStore } = require("../dist/config/kols");
async function runtime(t) {
  const r = createApp();
  const server = r.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    r.close();
    server.close();
  });
  return { ...r, url: `http://127.0.0.1:${server.address().port}` };
}
test("local API: bypass works, malformed queries fail, admin writes require auth", async (t) => {
  const r = await runtime(t);
  let res = await fetch(r.url + "/v1/signals");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).signals, []);
  for (const query of [
    "limit=-1",
    "limit=2abc",
    "limit=101",
    "limit[x]=2",
    "action=HOLD",
    "minConviction=101",
    "tokenFilter=",
    "unknown=1",
  ])
    assert.equal(
      (await fetch(r.url + "/v1/signals?" + query)).status,
      400,
      query,
    );
  assert.equal(
    (
      await fetch(r.url + "/v1/kols", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-admin-token",
  };
  assert.equal(
    (
      await fetch(r.url + "/v1/kols", {
        method: "POST",
        headers,
        body: JSON.stringify({ address: "x".repeat(44) }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(r.url + "/v1/kols", {
        method: "POST",
        headers,
        body: JSON.stringify({
          address: "So11111111111111111111111111111111111111112",
          winRate: 1,
        }),
      })
    ).status,
    400,
  );
  res = await fetch(r.url + "/v1/kols", {
    method: "POST",
    headers,
    body: JSON.stringify({
      address: "So11111111111111111111111111111111111111112",
      label: "Test wallet",
    }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).kol.winRate, null);
  for (const path of [
    "/",
    "/docs/",
    "/openapi.json",
    "/llms.txt",
    "/llms-full.txt",
    "/robots.txt",
    "/sitemap.xml",
    "/og-image.svg",
  ])
    assert.equal((await fetch(r.url + path)).status, 200, path);
  const health = await (await fetch(r.url + "/health")).json();
  assert.equal(health.dataMode, "unconfigured");
  assert.equal(health.payments, "development_bypass");
  assert.equal((await fetch(r.url + "/v1/signals/social")).status, 503);
});
test("production ignores bypass; missing payment configuration fails closed", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const r = await runtime(t);
  try {
    assert.equal(
      (
        await fetch(r.url + "/v1/signals", {
          headers: { "x-payment": "forged-proof-that-used-to-work" },
        })
      ).status,
      503,
    );
  } finally {
    process.env.NODE_ENV = previous || "";
  }
});
test("wallet additions persist with DATA_DIR; stores do not share seed object mutations", () => {
  const dir = mkdtempSync(join(tmpdir(), "sentric-"));
  config.dataDir = dir;
  try {
    const a = new KolStore();
    const first = a.getAll()[0];
    first.label = "Changed";
    assert.notEqual(new KolStore().get(first.address).label, "Changed");
    a.add({ ...first, address: "So11111111111111111111111111111111111111112" });
    assert.equal(
      new KolStore().get("So11111111111111111111111111111111111111112").label,
      "Changed",
    );
  } finally {
    config.dataDir = "";
    rmSync(dir, { recursive: true, force: true });
  }
});
