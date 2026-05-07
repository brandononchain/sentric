import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * x402 Payment Middleware
 *
 * Implements the x402 protocol flow:
 * 1. Client makes a request
 * 2. Server responds 402 with payment terms in headers
 * 3. Client sends signed payment in PAYMENT header
 * 4. Server verifies payment and serves content
 *
 * For hackathon MVP, we implement the 402 response format
 * and accept a simplified payment proof. In production,
 * this delegates to Coinbase's x402 facilitator for
 * on-chain settlement verification.
 */

interface X402Options {
  priceUsdc: number;
  asset?: string; // USDC mint
  network?: string;
}

export function x402PaymentGate(options: X402Options) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check for payment header
    const paymentHeader = (req.headers["x-payment"] || req.headers["payment-signature"] || "") as string;

    if (!paymentHeader || paymentHeader.length === 0) {
      // Return 402 with payment terms
      const terms = {
        asset: options.asset || config.usdcMint,
        amount: Math.round(options.priceUsdc * 1_000_000).toString(), // USDC has 6 decimals
        recipient: config.treasuryWallet,
        network: options.network || "solana:mainnet-beta",
        protocol: "x402",
        version: "1.0",
      };

      res.setHeader("X-Payment-Required", JSON.stringify(terms));
      res.setHeader(
        "X-Payment-Terms",
        `${options.priceUsdc} USDC per request`
      );

      res.status(402).json({
        error: "payment_required",
        message: "This endpoint requires x402 payment",
        terms,
        docs: "https://solana.com/x402",
      });
      return;
    }

    // === Payment Verification ===
    //
    // In production, we would:
    // 1. Decode the payment signature from the header
    // 2. Send it to the Coinbase x402 facilitator for verification
    // 3. The facilitator checks the on-chain transfer happened
    // 4. If valid, serve the content
    //
    // For the hackathon MVP, we accept any non-empty payment header
    // as proof of payment. This lets us demo the full flow without
    // requiring real USDC or a live facilitator connection.
    //
    // The x402 protocol spec: https://docs.cdp.coinbase.com/x402/welcome

    // TODO: Replace with real facilitator verification
    // const isValid = await verifyWithFacilitator(paymentHeader, options);
    const isValid = validatePaymentProof(paymentHeader as string, options);

    if (!isValid) {
      res.status(402).json({
        error: "invalid_payment",
        message: "Payment signature could not be verified",
      });
      return;
    }

    // Payment accepted — proceed to handler
    // Tag the request with payment metadata
    (req as any).x402 = {
      paid: true,
      amount: options.priceUsdc,
      asset: "USDC",
      network: "solana",
    };

    next();
  };
}

/**
 * MVP payment validation.
 * In production, this calls the Coinbase x402 facilitator API.
 */
function validatePaymentProof(
  proof: string,
  _options: X402Options
): boolean {
  // Accept any base58 or hex string > 32 chars as a "payment"
  // This is placeholder logic for demo purposes
  if (!proof || proof.length < 10) return false;

  // In production:
  // 1. Decode the proof (base64 JSON with signature + tx details)
  // 2. POST to facilitator: https://x402.coinbase.com/verify
  // 3. Facilitator checks on-chain that USDC was transferred
  // 4. Return true if settlement confirmed

  return true;
}

/**
 * Free tier middleware — no payment required.
 * Used for health checks, docs, and limited public endpoints.
 */
export function freeTier() {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}

/**
 * Dev mode — skip payment entirely if SENTRY_DEV_MODE=true
 */
export function devModeBypass() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.SENTRY_DEV_MODE === "true") {
      (req as any).x402 = { paid: true, amount: 0, asset: "USDC", network: "devnet" };
      next();
      return;
    }
    next();
  };
}
