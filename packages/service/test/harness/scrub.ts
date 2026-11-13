/**
 * Mask volatile values so golden snapshots only change when behaviour changes.
 * Keys matching VOLATILE_KEYS are replaced by placeholders; ISO timestamps and UUIDs anywhere
 * are masked. Extend VOLATILE_KEYS for your dataset's generated fields.
 */
export const VOLATILE_KEYS = new Set(['id', 'requestId', 'createdAt', 'updatedAt', 'created_at', 'updated_at', 'nextCursor', 'serverTime', 'latencyMs', 'uptimeS']);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scrub(value: unknown, keys: Set<string> = VOLATILE_KEYS): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, keys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, keys.has(k) && v !== null ? `<${k}>` : scrub(v, keys)]),
    );
  }
  if (typeof value === 'string') {
    if (ISO.test(value)) return '<timestamp>';
    if (UUID.test(value)) return '<uuid>';
  }
  return value;
}
