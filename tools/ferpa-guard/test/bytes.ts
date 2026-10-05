// Shared byte-search helper for the FERPA-guard leak checks — one definition, so
// every "does this artifact contain the key?" assertion behaves the same.

/** True if `needle`'s bytes appear as a contiguous run inside `haystack`. An empty needle never matches. */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}
