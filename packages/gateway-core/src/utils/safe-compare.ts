/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses a bitwise OR accumulator so every byte is always compared.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= (bufA[i] as number) ^ (bufB[i] as number);
  }
  return result === 0;
}
