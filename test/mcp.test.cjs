const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
process.env.SENTRIC_DEV_MODE = "true";
process.env.HELIUS_API_KEY = "";
const { createApp } = require("../dist/api/server");
test("MCP stdio initializes, lists tools and executes signal/status requests", async () => {
  const runtime = createApp();
  const http = runtime.app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/agent/mcp.js"],
    env: {
      ...process.env,
      SENTRIC_API_URL: `http://127.0.0.1:${http.address().port}`,
    },
  });
  const client = new Client({ name: "sentric-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    const status = await client.callTool({
      name: "sentric_status",
      arguments: {},
    });
    assert.equal(JSON.parse(status.content[0].text).dataMode, "unconfigured");
    const result = await client.callTool({
      name: "sentric_signals",
      arguments: { limit: 5 },
    });
    assert.deepEqual(JSON.parse(result.content[0].text).signals, []);
  } finally {
    await client.close();
    runtime.close();
    http.close();
  }
});
