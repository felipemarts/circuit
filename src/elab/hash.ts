/**
 * FNV-1a 64-bit hash, hex encoded. Used as the netlist identity anchor —
 * fast, dependency-free, browser-safe. It is an identity, not a cryptographic
 * digest.
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
