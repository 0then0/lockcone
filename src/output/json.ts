import type { Report } from '../analysis/diff.js';

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}
