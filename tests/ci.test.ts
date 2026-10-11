import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { explain } from '../src/analysis/explain.js';
import { fixture } from './helpers.js';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};
const report = explain(fixture('upgrade', 'base'), fixture('upgrade', 'head'));

describe.each([
  ['test', 'Validate the action report'],
  ['action-macos', 'Validate both reports use distinct temporary paths'],
])('CI report contract: %s', (job, step) => {
  it.each([
    ['current report', {}, 0],
    ['old schema', { schemaVersion: 3 }, 1],
    ['wrong base', { base: 'wrong' }, 1],
    ['wrong head', { head: 'wrong' }, 1],
  ])('%s', (_name, changes, exit) => {
    const temporary = mkdtempSync(join(tmpdir(), 'lockcone-ci-'));
    try {
      const first = join(temporary, 'first.json');
      const second = join(temporary, 'second.json');
      // The macOS validator must check the second report as well as the first.
      writeFileSync(
        first,
        JSON.stringify(job === 'test' ? { ...report, ...changes } : report),
      );
      writeFileSync(second, JSON.stringify({ ...report, ...changes }));
      const command = workflow.jobs[job]!.steps.find((item) => item.name === step)?.run;
      expect(command).toBeDefined();
      const result = spawnSync('/bin/sh', ['-c', command!], {
        env: {
          ...process.env,
          LOCKCONE_REPORT: first,
          REPORT_ONE: first,
          REPORT_TWO: second,
          LOCKCONE_BASE: report.base,
          LOCKCONE_HEAD: report.head,
        },
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exit);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
