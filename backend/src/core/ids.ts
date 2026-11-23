/**
 * Stable content-derived identifiers; equal inputs always produce the same id.
 */

/** The first 32 hex characters of the SHA-256 of the JSON array of `values`. */
export function key(values: readonly string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(values));
  return hasher.digest("hex").slice(0, 32);
}
