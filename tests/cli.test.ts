import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revisions } from '../src/cli/commands/diff.js';
import { fixture } from './helpers.js';

const cli = resolve('dist/cli/index.js');
let temporary: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), 'lockcone-cli-'));
  // A deterministic Git transport double exercises the compiled executable without
  // creating commits or modifying the user's Git repository.
  const states = Object.fromEntries(
    ['base', 'head'].map((side) => [
      side,
      Object.fromEntries(fixture('upgrade', side).files),
    ]),
  );
  writeFileSync(join(temporary, 'states.json'), JSON.stringify(states));
  const shim = join(temporary, 'git');
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const states = JSON.parse(fs.readFileSync(process.env.LOCKCONE_TEST_STATES, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') process.stdout.write(process.cwd());
else if (args[0] === 'rev-parse') {
  const ref = args.at(-1).replace(/\\^\\{commit\\}$/, '');
  const side = ({ 'main': 'base', 'HEAD~1': 'base', 'HEAD': 'head' })[ref];
  if (!side) { process.stderr.write('unknown revision'); process.exit(128); }
  process.stdout.write(side);
} else if (args[0] === 'ls-tree') {
  const side = args.at(-1);
  process.stdout.write(Object.keys(states[side]).map(path => {
    const oid = side + ':' + Buffer.from(path).toString('base64');
    return '100644 blob ' + oid + '\\t' + path + '\\0';
  }).join(''));
} else if (args[0] === 'cat-file' && args[1] === '--batch') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    for (const oid of input.trim().split('\\n')) {
      const [side, encodedPath] = oid.split(':');
      const content = states[side][Buffer.from(encodedPath, 'base64').toString()];
      if (content === undefined) { process.stderr.write('missing object'); process.exit(128); }
      process.stdout.write(oid + ' blob ' + Buffer.byteLength(content) + '\\n' + content + '\\n');
    }
  });
} else process.exit(128);
`,
  );
  chmodSync(shim, 0o755);
  env = {
    ...process.env,
    PATH: `${temporary}${delimiter}${process.env.PATH}`,
    LOCKCONE_TEST_STATES: join(temporary, 'states.json'),
  };
});

afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});

describe('compiled CLI', () => {
  it('shows help and version', () => {
    expect(
      execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }),
    ).toContain('Git blame for dependency changes');
    expect(
      execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(),
    ).toBe('0.1.0');
  });

  it('reads both Git states and emits parseable JSON, keeping unexplained changes non-fatal', () => {
    const result = spawnSync(
      process.execPath,
      [cli, 'diff', 'main..HEAD', '--format', 'json'],
      { env, encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.base).toBe('base');
    expect(report.head).toBe('head');
    expect(report.summary).toEqual({
      explained: 4,
      'partially-explained': 0,
      unexplained: 2,
      unknown: 0,
    });
  });

  it('supports explicit refs, why, and explain defaults', () => {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'why', 'vite', '--base', 'main', '--head', 'HEAD', '--format', 'json'],
        { env, encoding: 'utf8' },
      ),
    );
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].name).toBe('vite');
    expect(
      execFileSync(process.execPath, [cli, 'explain'], { env, encoding: 'utf8' }),
    ).toContain('Outside dependency cone');
  });

  it.each([
    ['diff', 'main...HEAD'],
    ['diff', 'main..HEAD', '--base', 'main'],
    ['diff', '--format', 'sarif'],
    ['diff', '--base', 'missing'],
  ])('rejects invalid arguments or missing refs: %j', (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe('');
  });

  it('chooses documented defaults', () => {
    expect(revisions(undefined, { cwd: '.', format: 'text' })).toEqual([
      'HEAD~1',
      'HEAD',
    ]);
  });
});
