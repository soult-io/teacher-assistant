// Crockford base32 for codes a human reads off one screen and types on another
// (the paper recovery code, the typed pairing-secret fallback). The alphabet drops
// I, L, O and U; normalisation folds the common mistypes (O→0, I/L→1), case,
// spaces and dashes, so a careful human transcription always decodes.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode bytes as unseparated Crockford base32 (5 bits per character, zero-padded). */
export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff; // ≤ 12 live bits; masking keeps it a small int
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Canonicalise a typed code: uppercase, drop separators/whitespace, and fold the
 * Crockford aliases (O→0, I/L→1) so a human transcription matches the original.
 */
export function normalizeCrockford(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * Decode a (possibly human-typed) Crockford string into exactly `byteLength` bytes.
 * Returns undefined — never a partial value — if the length is wrong, a character is
 * outside the alphabet, or the unused trailing pad bits are not zero (so every byte
 * string has exactly one accepted encoding).
 */
export function decodeCrockford(code: string, byteLength: number): Uint8Array | undefined {
  const text = normalizeCrockford(code);
  if (text.length !== Math.ceil((byteLength * 8) / 5)) {
    return undefined;
  }
  const out = new Uint8Array(byteLength);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) {
      return undefined;
    }
    value = ((value << 5) | digit) & 0x1fff; // ≤ 13 live bits
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >>> bits) & 0xff;
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }
  return out;
}

/** Split a code into dash-separated groups of four for display and transcription. */
export function groupFours(text: string): string {
  return (text.match(/.{1,4}/g) ?? [text]).join("-");
}
