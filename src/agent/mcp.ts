import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SentricClient, SentricApiError } from "./client";

const client = new SentricClient(
  process.env.SENTRIC_API_URL || "http://127.0.0.1:3000",
);
const server = new McpServer({ name: "sentric", version: "0.2.0" });
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const result = async (run: () => Promise<unknown>) => {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await run()) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            error instanceof SentricApiError
              ? {
                  status: error.status,
                  details: error.details,
                  payment:
                    "This MCP server does not hold keys or sign payments. Use a local development API or a payment-enabled client.",
                }
              : { error: "Sentric API unavailable" },
          ),
        },
      ],
    };
  }
};
server.registerTool(
  "sentric_status",
  {
    description:
      "Check Sentric ingestion freshness, provider configuration and payment availability before interpreting any signals.",
    annotations,
  },
  () => result(() => client.health()),
);
server.registerTool(
  "sentric_wallets",
  {
    description:
      "List the operator-supplied Solana watchlist. Labels are not verified identity claims; unknown performance metrics are null.",
    annotations,
  },
  () => result(() => client.wallets()),
);
server.registerTool(
  "sentric_preview",
  {
    description:
      "Read a free limited preview of up to seven recent Solana signals. Scores are heuristics, not probabilities or trade instructions.",
    annotations,
  },
  () => result(() => client.preview()),
);
server.registerTool(
  "sentric_signals",
  {
    description:
      "Filter recent signals by direction, conviction and mint. Requires a local development API; production payment errors are returned without spending funds.",
    annotations,
    inputSchema: {
      action: z.enum(["BUY", "SELL"]).optional(),
      minConviction: z.number().int().min(0).max(100).optional(),
      maxAge: z.number().int().min(1).max(86400).optional(),
      tokenFilter: z.string().max(2000).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  (args) => result(() => client.signals(args)),
);
server.registerTool(
  "sentric_consensus",
  {
    description:
      "Find multiple distinct wallets buying or selling the same token. Buy and sell groups are separate; results require independent evaluation.",
    annotations,
    inputSchema: {
      minKols: z.number().int().min(2).max(100).default(2),
      window: z.number().int().min(1).max(86400).default(300),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  (args) => result(() => client.consensus(args)),
);
server.connect(new StdioServerTransport()).catch(() => {
  console.error("Sentric MCP failed to start");
  process.exitCode = 1;
});
