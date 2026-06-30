/**
 * Handle Map
 *
 * Kolscan labels are trading handles, which often differ from the KOL's
 * actual X handle. The most important example: "@ansem" on Kolscan is
 * "@blknoiz06" on X.
 *
 * Where a mapping is known, we hardcode it. Otherwise we fall back to the
 * label with the @ stripped (which is correct for most mid-tier KOLs whose
 * Kolscan name == X name).
 */

const HANDLE_OVERRIDES: Record<string, string> = {
  "@ansem": "blknoiz06",
  // Add more as confirmed:
  // "@theo": "...",
  // "@Cented": "...",
};

/**
 * Resolve a KOL label to their best-guess X handle.
 */
export function labelToXHandle(label: string): string {
  const override = HANDLE_OVERRIDES[label];
  if (override) return override;
  // Default: strip the leading @
  return label.replace(/^@/, "");
}
