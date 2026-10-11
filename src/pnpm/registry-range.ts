// A bounded stable-registry range contract, not a resolver. Unsupported syntax
// returns undefined rather than guessing about its meaning.
type Version = [number, number, number];
type Predicate = (version: Version) => boolean;

function versionParts(source: string): (number | null)[] | undefined {
  if (!/^(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}$/.test(source))
    return undefined;
  const parts = source
    .split('.')
    .map((part) => (/^[xX*]$/.test(part) ? null : Number(part)));
  if (parts.some((part) => part !== null && !Number.isSafeInteger(part)))
    return undefined;
  const wildcard = parts.indexOf(null);
  if (wildcard >= 0 && parts.slice(wildcard).some((part) => part !== null))
    return undefined;
  return parts;
}

function compare(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function bounds(parts: (number | null)[]): {
  lower: Version;
  upper: Version | null;
  count: number;
} {
  const count = parts.indexOf(null) < 0 ? parts.length : parts.indexOf(null);
  const lower: Version = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const upper: Version | null =
    count === 0 || count === 3
      ? null
      : count === 1
        ? [lower[0] + 1, 0, 0]
        : [lower[0], lower[1] + 1, 0];
  return { lower, upper, count };
}

function term(source: string): Predicate | undefined {
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(source);
  if (!match) return undefined;
  const parts = versionParts(match[2]!);
  if (!parts) return undefined;
  const { lower, upper, count } = bounds(parts);
  const operator = match[1] ?? '=';
  if (count === 0)
    return operator === '=' || operator === '^' || operator === '~'
      ? () => true
      : undefined;
  if (operator === '=' && count === 3) return (v) => compare(v, lower) === 0;
  if (operator === '>=' || operator === '<')
    return (v) => (operator === '>=' ? compare(v, lower) >= 0 : compare(v, lower) < 0);
  if (operator === '>')
    return (v) => (upper ? compare(v, upper) >= 0 : compare(v, lower) > 0);
  if (operator === '<=')
    return (v) => (upper ? compare(v, upper) < 0 : compare(v, lower) <= 0);
  const limit: Version | null =
    operator === '^'
      ? lower[0] > 0 || count === 1
        ? [lower[0] + 1, 0, 0]
        : lower[1] > 0 || count === 2
          ? [0, lower[1] + 1, 0]
          : [0, 0, lower[2] + 1]
      : operator === '~'
        ? count === 1
          ? [lower[0] + 1, 0, 0]
          : [lower[0], lower[1] + 1, 0]
        : upper;
  return (v) => compare(v, lower) >= 0 && (limit === null || compare(v, limit) < 0);
}

function range(source: string): Predicate | undefined {
  if (!source.trim()) return undefined;
  const alternatives: Predicate[][] = [];
  for (const branch of source.trim().split(/\s*\|\|\s*/)) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(branch);
    if (hyphen) {
      const from = versionParts(hyphen[1]!);
      const to = versionParts(hyphen[2]!);
      if (!from || !to || from.includes(null) || to.includes(null)) return undefined;
      const lower = bounds(from).lower;
      const last = bounds(to);
      alternatives.push([
        (v) =>
          compare(v, lower) >= 0 &&
          (last.upper ? compare(v, last.upper) < 0 : compare(v, last.lower) <= 0),
      ]);
      continue;
    }
    const terms = branch
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .map(term);
    if (!terms.length || terms.some((item) => item === undefined)) return undefined;
    alternatives.push(terms as Predicate[]);
  }
  return (v) => alternatives.some((terms) => terms.every((test) => test(v)));
}

export function supportedRegistryRange(source: string): boolean {
  return range(source) !== undefined;
}

export function satisfiesRegistryRange(
  source: string,
  resolution: string,
): boolean | undefined {
  const test = range(source);
  const parts = versionParts(resolution);
  if (!test || !parts || parts.length !== 3 || parts.includes(null)) return undefined;
  return test(parts as Version);
}
