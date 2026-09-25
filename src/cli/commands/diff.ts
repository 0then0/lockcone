import type { Report } from '../../analysis/diff.js';
import { explain, why } from '../../analysis/explain.js';
import { readRepository } from '../../git/repository.js';

export interface Options {
  base?: string;
  head?: string;
  cwd: string;
  format: 'text' | 'json';
}

export function revisions(
  range: string | undefined,
  options: Options,
): [string, string] {
  if (range !== undefined) {
    if (options.base !== undefined || options.head !== undefined)
      throw new Error('Use a range or --base/--head, not both.');
    const match = /^(.+?)\.\.([^.].*)$/.exec(range);
    if (!match || range.includes('...'))
      throw new Error('Expected a two-dot range, for example main..HEAD.');
    return [match[1]!, match[2]!];
  }
  return [options.base ?? 'HEAD~1', options.head ?? 'HEAD'];
}

export async function runDiff(
  range: string | undefined,
  options: Options,
  name?: string,
): Promise<Report> {
  const [base, head] = revisions(range, options);
  const [baseState, headState] = await Promise.all([
    readRepository(options.cwd, base),
    readRepository(options.cwd, head),
  ]);
  const report = explain(baseState, headState);
  return name === undefined ? report : why(report, name);
}
