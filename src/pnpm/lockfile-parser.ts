import { parse, parseAllDocuments } from 'yaml';
import { z } from 'zod';

const references = z.record(z.string(), z.string()).default({});
const importerDependencies = z
  .record(
    z.string(),
    z.object({
      specifier: z.string(),
      version: z.string(),
    }),
  )
  .default({});
const importer = z
  .object({
    dependencies: importerDependencies,
    devDependencies: importerDependencies,
    optionalDependencies: importerDependencies,
  })
  .passthrough();
const metadata = z.object({ peerDependencies: references }).passthrough();
const snapshot = z
  .object({
    dependencies: references,
    optionalDependencies: references,
    transitivePeerDependencies: z.array(z.string()).default([]),
  })
  .passthrough();
const schema = z
  .object({
    lockfileVersion: z.union([z.string(), z.number()]),
    importers: z.record(z.string(), importer),
    packages: z.record(z.string(), metadata).default({}),
    snapshots: z.record(z.string(), snapshot).default({}),
  })
  .passthrough();
export type Lockfile = z.infer<typeof schema>;

export function parseYaml(source: string): unknown {
  return parse(source, { maxAliasCount: 100, uniqueKeys: true });
}

export function parseLockfile(source: string): Lockfile {
  const documents = parseAllDocuments(source, { uniqueKeys: true }).map((document) => {
    if (document.errors.length) throw document.errors[0];
    return document.toJS({ maxAliasCount: 100 }) as unknown;
  });
  let environment: Lockfile | undefined;
  if (documents.length === 2) {
    environment = schema.parse(documents[0]);
    const importers = Object.values(environment.importers);
    if (
      !importers.some(
        (item) => 'configDependencies' in item || 'packageManagerDependencies' in item,
      ) ||
      importers.some(
        (item) =>
          Object.keys(item.dependencies).length +
            Object.keys(item.devDependencies).length +
            Object.keys(item.optionalDependencies).length >
          0,
      )
    ) {
      throw new Error(
        'Expected a pnpm environment document followed by a dependency lockfile.',
      );
    }
  } else if (documents.length !== 1) {
    throw new Error(
      'Expected one dependency lockfile with at most one pnpm environment document.',
    );
  }
  const lockfile = schema.parse(documents.at(-1));
  if (!/^9(?:\.\d+)?$/.test(String(lockfile.lockfileVersion))) {
    throw new Error(
      `Unsupported pnpm lockfile version: ${lockfile.lockfileVersion}. Expected v9.`,
    );
  }
  if (environment) {
    if (!/^9(?:\.\d+)?$/.test(String(environment.lockfileVersion)))
      throw new Error('Unsupported pnpm environment lockfile version.');
    lockfile.environment = environment;
  }
  return lockfile;
}

export function parseWorkspace(source: string | undefined): Record<string, unknown> {
  if (source === undefined) return {};
  return z.record(z.string(), z.unknown()).parse(parseYaml(source));
}
