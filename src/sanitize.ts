export function sanitizeTerminalControls(value: string, replacement = ''): string {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    const isBidiControl =
      point === 0x061c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069);
    return point < 0x20 || (point >= 0x7f && point <= 0x9f) || isBidiControl
      ? replacement
      : character;
  }).join('');
}

// Report-local labels keep URL identities distinct when their public parts match.
function urlRedactor(): (value: string) => string {
  const labels = new Map<string, number>();
  return (value) =>
    value.replace(
      /(https?:\/\/)([^/?#\s"<>\\]+)([^?#\s"<>\\]*)([?#][^\s"<>\\]*)?/gi,
      (
        url: string,
        scheme: string,
        authority: string,
        path: string,
        suffix?: string,
      ) => {
        const at = authority.lastIndexOf('@');
        if (at < 0 && suffix === undefined) return url;
        const label = labels.get(url) ?? labels.size + 1;
        labels.set(url, label);
        return `${scheme}${authority.slice(at + 1)}${path}?[redacted-${label}]`;
      },
    );
}

export function redactUrlFields<T>(source: T): T {
  const redact = urlRedactor();
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      // Path IDs can contain URLs and appear as both keys and values.
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key), visit(item)]),
      );
    }
    return value;
  };
  return visit(source) as T;
}
