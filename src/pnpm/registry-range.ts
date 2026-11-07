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

// A range as a union of intervals over a dense version order. Dense on purpose:
// node-semver decides `intersects` from comparator bounds, so `>1.0.0` and `<1.0.1`
// intersect even though no stable version lies between them. A caret, tilde, or
// x-range upper bound is open at the next version, which is the same as node-semver's
// `<next-0` for every stable bound.
interface Interval {
  lower: Version | null;
  lowerOpen: boolean;
  upper: Version | null;
  upperOpen: boolean;
}

const closedFrom = (lower: Version): Interval => ({
  lower,
  lowerOpen: false,
  upper: null,
  upperOpen: false,
});

function termIntervals(source: string): Interval[] | undefined {
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(source);
  if (!match) return undefined;
  const parts = versionParts(match[2]!);
  if (!parts) return undefined;
  const { lower, upper, count } = bounds(parts);
  const operator = match[1] ?? '=';
  if (count === 0)
    return operator === '=' || operator === '^' || operator === '~'
      ? [{ lower: null, lowerOpen: false, upper: null, upperOpen: false }]
      : undefined;
  if (operator === '=' && count === 3)
    return [{ lower, lowerOpen: false, upper: lower, upperOpen: false }];
  if (operator === '>=') return [closedFrom(lower)];
  if (operator === '<')
    return [{ lower: null, lowerOpen: false, upper: lower, upperOpen: true }];
  if (operator === '>')
    return [
      upper
        ? closedFrom(upper)
        : { lower, lowerOpen: true, upper: null, upperOpen: false },
    ];
  if (operator === '<=')
    return [
      upper
        ? { lower: null, lowerOpen: false, upper, upperOpen: true }
        : { lower: null, lowerOpen: false, upper: lower, upperOpen: false },
    ];
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
  return [{ lower, lowerOpen: false, upper: limit, upperOpen: limit !== null }];
}

function intersectTwo(left: Interval, right: Interval): Interval | null {
  const lower =
    left.lower === null
      ? right
      : right.lower === null
        ? left
        : compare(left.lower, right.lower) >= 0
          ? left
          : right;
  const lowerTie =
    left.lower !== null &&
    right.lower !== null &&
    compare(left.lower, right.lower) === 0;
  const upper =
    left.upper === null
      ? right
      : right.upper === null
        ? left
        : compare(left.upper, right.upper) <= 0
          ? left
          : right;
  const upperTie =
    left.upper !== null &&
    right.upper !== null &&
    compare(left.upper, right.upper) === 0;
  const result: Interval = {
    lower: lower.lower,
    lowerOpen: lowerTie ? left.lowerOpen || right.lowerOpen : lower.lowerOpen,
    upper: upper.upper,
    upperOpen: upperTie ? left.upperOpen || right.upperOpen : upper.upperOpen,
  };
  if (result.lower !== null && result.upper !== null) {
    const order = compare(result.lower, result.upper);
    if (order > 0 || (order === 0 && (result.lowerOpen || result.upperOpen)))
      return null;
  }
  return result;
}

function rangeIntervals(source: string): Interval[] | undefined {
  if (!source.trim()) return undefined;
  const alternatives: Interval[] = [];
  for (const branch of source.trim().split(/\s*\|\|\s*/)) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(branch);
    let current: Interval | null;
    if (hyphen) {
      const from = versionParts(hyphen[1]!);
      const to = versionParts(hyphen[2]!);
      if (!from || !to || from.includes(null) || to.includes(null)) return undefined;
      const last = bounds(to);
      current = {
        lower: bounds(from).lower,
        lowerOpen: false,
        upper: last.upper ?? last.lower,
        upperOpen: last.upper !== null,
      };
      if (compare(current.lower!, current.upper!) > 0) current = null;
    } else {
      const terms = branch
        .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
        .split(/\s+/)
        .map(termIntervals);
      if (!terms.length || terms.some((item) => item === undefined)) return undefined;
      current = { lower: null, lowerOpen: false, upper: null, upperOpen: false };
      for (const item of terms) {
        current = current === null ? null : intersectTwo(current, item![0]!);
      }
    }
    if (current !== null) alternatives.push(current);
  }
  return alternatives;
}

// True when some version, prereleases included, satisfies both ranges: the check pnpm
// makes between an override's target range and a declared dependency range. Identical
// text is the caller's concern. undefined means a range is outside the supported syntax.
// Compared with node-semver 7.8.5 on about 870,000 range pairs; the results differ only
// for ranges that contain the empty set, such as `1 <0.x`.
export function rangesIntersect(left: string, right: string): boolean | undefined {
  const first = rangeIntervals(left);
  const second = rangeIntervals(right);
  if (!first || !second) return undefined;
  return first.some((a) => second.some((b) => intersectTwo(a, b) !== null));
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
