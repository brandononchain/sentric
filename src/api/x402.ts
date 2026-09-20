import { RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { assertIsAddress } from "@solana/kit";
import { config } from "../config";

export function createPaymentGate(): {
  middleware: RequestHandler;
  status: () => string;
} {
  if (config.devMode) {
    if (process.env.NODE_ENV === "production")
      throw new Error("SENTRIC_DEV_MODE is forbidden in production");
    return {
      status: () => "development_bypass",
      middleware: (_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Sentric-Payment-Mode", "development");
        next();
      },
    };
  }
  let state = "not_configured";
  let middleware: RequestHandler | undefined;
  let ready: Promise<void> | undefined;
  let retryAfter = 0;
  if (config.facilitatorUrl && config.treasuryWallet) {
    assertIsAddress(config.treasuryWallet);
    const url = new URL(config.facilitatorUrl);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw new Error("Facilitator URL must use HTTPS");
    const networks = [
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ];
    if (!networks.includes(config.paymentNetwork))
      throw new Error("Unsupported X402_NETWORK");
    for (const price of [config.signalPriceUsdc, config.consensusPriceUsdc]) {
      if (
        !Number.isFinite(price) ||
        price < 0.000001 ||
        !Number.isSafeInteger(Math.round(price * 1e6))
      )
        throw new Error("Invalid USDC price");
    }
    const auth = { Authorization: `Bearer ${config.facilitatorToken}` };
    const facilitator = new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      timeoutMs: 15000,
      ...(config.facilitatorToken
        ? {
            createAuthHeaders: async () => ({
              verify: auth,
              settle: auth,
              supported: auth,
            }),
          }
        : {}),
    });
    const resource = new x402ResourceServer(facilitator).register(
      config.paymentNetwork as `${string}:${string}`,
      new ExactSvmScheme(),
    );
    const route = (price: number, description: string) => ({
      accepts: {
        scheme: "exact",
        price: `$${price}`,
        network: config.paymentNetwork as `${string}:${string}`,
        payTo: config.treasuryWallet,
      },
      description,
      mimeType: "application/json",
    });
    const initialize = async () => {
      state = "initializing";
      try {
        await resource.initialize();
        middleware = paymentMiddleware(
          {
            "GET /v1/signals": route(
              config.signalPriceUsdc,
              "Scored Solana wallet signals",
            ),
            "GET /v1/signals/consensus": route(
              config.consensusPriceUsdc,
              "Same-direction wallet consensus",
            ),
            "GET /v1/signals/social": route(
              config.signalPriceUsdc,
              "Optional social context",
            ),
          },
          resource,
          undefined,
          undefined,
          false,
        );
        state = "ready";
      } catch {
        state = "unavailable";
        retryAfter = Date.now() + 30000;
      }
    };
    state = "configured";
    return {
      status: () => state,
      middleware: async (req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        if (!middleware && Date.now() >= retryAfter) {
          ready ??= initialize().finally(() => {
            ready = undefined;
          });
          await ready;
        }
        if (!middleware) {
          res
            .status(503)
            .json({
              error: "payments_unavailable",
              message:
                "Payment facilitator is unavailable. No payment has been requested.",
            });
          return;
        }
        try {
          await middleware(req, res, next);
        } catch {
          if (!res.headersSent)
            res
              .status(503)
              .json({
                error: "payment_processing_failed",
                message:
                  "Do not retry a signed payment automatically; check settlement status first.",
              });
        }
      },
    };
  }
  return {
    status: () => state,
    middleware: (_req, res) => {
      res
        .status(503)
        .json({
          error: "payments_not_configured",
          message:
            "Configure a Solana x402 facilitator and treasury, or enable local development mode.",
        });
    },
  };
}
