/** Best-effort readable text for a thrown or rejected value whose type is unknown. */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return typeof value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
