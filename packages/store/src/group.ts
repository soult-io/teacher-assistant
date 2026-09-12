// Small grouping primitive shared by the store projections (M3 dashboard lenses,
// M13 para administer rows). Buckets items by a string key, preserving each
// bucket's insertion order; callers sort the keys (compareCodePoints) and shape
// the buckets themselves.

export function bucketBy<V>(items: Iterable<V>, keyOf: (value: V) => string): Map<string, V[]> {
  const buckets = new Map<string, V[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  return buckets;
}
