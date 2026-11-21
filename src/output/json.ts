import type { Report } from '../analysis/diff.js';
import { redactUrlFields } from '../sanitize.js';

export function renderJson(report: Report): string {
  return JSON.stringify(redactUrlFields(report), null, 2);
}
