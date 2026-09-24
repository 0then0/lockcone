import { readFileSync } from 'node:fs';
import { explain } from '../dist/analysis/explain.js';
import { renderText } from '../dist/output/text.js';

const read = (side) => ({
  revision: side,
  files: new Map(
    ['package.json', 'pnpm-lock.yaml'].map((path) => [
      path,
      readFileSync(
        new URL(`../tests/fixtures/upgrade/${side}/${path}`, import.meta.url),
        'utf8',
      ),
    ]),
  ),
});

console.log(renderText(explain(read('base'), read('head'))));
