import { z } from "zod";
import { assertIsAddress } from "@solana/kit";
export const address = z.string().refine((value) => {
  try {
    assertIsAddress(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a Solana public key");
const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const list = z
  .string()
  .min(1)
  .max(2000)
  .transform((v) => v.split(","))
  .refine(
    (v) => v.length <= 25 && v.every((s) => s.length > 0),
    "Use 1–25 comma-separated values",
  );
export const signalQuery = z
  .object({
    minConviction: integer(0, 100).optional(),
    maxAge: integer(1, 86400).optional(),
    limit: integer(1, 100).optional(),
    action: z.enum(["BUY", "SELL"]).optional(),
    tokenFilter: list.optional(),
    kolFilter: list.optional(),
  })
  .strict();
export const consensusQuery = z
  .object({
    minKols: integer(2, 100).optional(),
    window: integer(1, 86400).optional(),
    minConviction: integer(0, 100).optional(),
    limit: integer(1, 100).optional(),
  })
  .strict();
export const socialQuery = z
  .object({
    priority: z.enum(["alpha", "confirmed"]).optional(),
    limit: integer(1, 100).optional(),
  })
  .strict();
export const walletBody = z
  .object({
    address,
    label: z.string().trim().min(1).max(64).optional(),
    tier: z.enum(["s", "a", "b", "c"]).default("b"),
    xHandle: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,15}$/)
      .optional(),
  })
  .strict();
