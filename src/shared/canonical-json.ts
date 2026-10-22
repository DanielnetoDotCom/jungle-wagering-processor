export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order, no
 * insignificant whitespace, `undefined` properties omitted. Numbers are
 * rejected on purpose: every business value in a hashed payload (including
 * money) is a string, so no float formatting can ever leak into a hash.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as { readonly [key: string]: CanonicalValue | undefined };
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as CanonicalValue)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Unsupported value in canonical JSON: ${typeof value}`);
}
