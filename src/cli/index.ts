#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { renderJson } from '../output/json.js';
import { renderText } from '../output/text.js';
import { sanitizeTerminalControls } from '../sanitize.js';
import type { Options } from './commands/diff.js';
import { runDiff } from './commands/diff.js';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
const program = new Command()
  .name('lockcone')
  .description('Git blame for dependency changes.')
  .version(version);

function options(command: Command): Command {
  return command
    .option('--base <ref>', 'base commit (default: HEAD~1)')
    .option('--head <ref>', 'head commit (default: HEAD)')
    .option('--cwd <path>', 'repository directory', process.cwd())
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['text', 'json'])
        .default('text'),
    );
}

function output(range: string | undefined, opts: Options, name?: string): void {
  const report = runDiff(range, opts, name);
  process.stdout.write(
    `${opts.format === 'json' ? renderJson(report) : renderText(report)}\n`,
  );
}

options(
  program
    .command('diff [range]')
    .description('Compare two committed dependency graphs'),
).action((range: string | undefined, opts: Options) => output(range, opts));
options(
  program
    .command('why <package>')
    .description('Show evidence for changes to one package'),
).action((name: string, opts: Options) => output(undefined, opts, name));
options(
  program
    .command('explain [range]')
    .description('Show the full dependency change report'),
).action((range: string | undefined, opts: Options) => output(range, opts));

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lockcone: ${sanitizeTerminalControls(message, ' ')}\n`);
  process.exitCode = 1;
}
