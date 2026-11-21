import { describe, expect, it } from 'vitest';
import { explain, why } from '../src/analysis/explain.js';
import { dependencyId, workspaceId } from '../src/graph/dependency-graph.js';
import { renderJson } from '../src/output/json.js';
import { renderText } from '../src/output/text.js';
import { state } from './helpers.js';

const url = 'http://example.test/a.tgz';
const hash = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const direct = 'packages/direct';
const transitive = 'packages/transitive';
const other = 'packages/other';

function scenario(
  resolution: unknown,
  options: {
    url?: string;
    otherReference?: string;
    noSnapshot?: boolean;
    ambiguous?: boolean;
  } = {},
) {
  const reference = options.url ?? url;
  const key = `a@${reference}`;
  const snapshots: Record<string, object> = options.noSnapshot ? {} : { [key]: {} };
  const packages = {
    [key]: { resolution },
    ...(options.ambiguous ? { [`${key}(peer@1.0.0)`]: { resolution } } : {}),
  };
  if (options.otherReference?.startsWith(reference))
    snapshots[`a@${options.otherReference}`] = {};
  const repository = state(
    { name: 'root' },
    {
      '.': {},
      [direct]: { dependencies: { a: { specifier: reference, version: reference } } },
      [transitive]: {
        dependencies: {
          direct: { specifier: 'workspace:*', version: 'link:../direct' },
        },
      },
      [other]: options.otherReference
        ? {
            dependencies: {
              a: { specifier: reference, version: options.otherReference },
            },
          }
        : {},
    },
    snapshots,
    { packages },
  );
  for (const [path, name, dependencies] of [
    [direct, 'direct', { a: reference }],
    [transitive, 'transitive', { direct: 'workspace:*' }],
    [other, 'other', options.otherReference ? { a: reference } : {}],
  ] as const)
    repository.files.set(
      `${path}/package.json`,
      JSON.stringify({ name, dependencies }),
    );
  return repository;
}

describe('tarball integrity losses', () => {
  it('reports the exact metadata loss and the direct and linked workspace paths', () => {
    const report = explain(
      scenario({ tarball: url, integrity: hash }),
      scenario({ tarball: url }),
    );
    const key = `a@${url}`;
    const directPath = [dependencyId(direct, 'dependencies', 'a'), key];
    const transitivePath = [
      dependencyId(transitive, 'dependencies', 'direct'),
      workspaceId(direct),
      ...directPath,
    ];
    expect(report.tarballIntegrity.changes).toHaveLength(1);
    const [change] = report.tarballIntegrity.changes;
    expect(change).toMatchObject({
      packageKey: key,
      tarball: url,
      integrity: { before: hash, after: null },
    });
    for (const side of [change!.base, change!.head]) {
      expect(side.coverage).toBe('recorded');
      expect(side.instances).toHaveLength(1);
      expect(
        side.instances[0]!.consumers.map(({ workspace, relation, path }) => ({
          workspace,
          relation,
          path,
        })),
      ).toEqual([
        { workspace: direct, relation: 'direct', path: directPath },
        { workspace: transitive, relation: 'transitive', path: transitivePath },
      ]);
    }
    const details = report.changes.find(
      ({ name, kind }) => name === 'a' && kind === 'package',
    )?.details;
    expect(details?.[0]?.metadataDiff).toContainEqual({
      path: '$.package.resolution.integrity',
      before: JSON.stringify(hash),
      after: null,
    });
    expect(JSON.parse(renderJson(report)).tarballIntegrity).toEqual(
      report.tarballIntegrity,
    );
    const text = renderText(report);
    expect(text).toContain(`resolution.integrity: ${hash} → (absent)`);
    expect(text).toContain(transitivePath.join(' → '));
    expect(text).not.toContain(other);
    expect(why(report, 'a').tarballIntegrity.changes).toEqual([change]);
    expect(why(report, 'other').tarballIntegrity.changes).toEqual([]);
  });

  it.each([
    [
      'unchanged integrity',
      { tarball: url, integrity: hash },
      { tarball: url, integrity: hash },
    ],
    [
      'changed URL',
      { tarball: `${url}?signature=old`, integrity: hash },
      { tarball: `${url}?signature=new` },
    ],
    ['absent on both sides', { tarball: url }, { tarball: url }],
    ['empty before', { tarball: url, integrity: '' }, { tarball: url }],
    [
      'malformed before',
      { tarball: url, integrity: 'sha512-invalid' },
      { tarball: url },
    ],
    ['unsupported before', { tarball: url, integrity: 'other-YQ==' }, { tarball: url }],
    ['empty after', { tarball: url, integrity: hash }, { tarball: url, integrity: '' }],
    [
      'null after',
      { tarball: url, integrity: hash },
      { tarball: url, integrity: null },
    ],
    [
      'invalid after',
      { tarball: url, integrity: hash },
      { tarball: url, integrity: false },
    ],
    [
      'unsupported after',
      { tarball: url, integrity: hash },
      { tarball: url, integrity: 'other-YQ==' },
    ],
    ['no tarball', { integrity: hash }, {}],
    [
      'non-HTTP source',
      { tarball: 'file:a.tgz', integrity: hash },
      { tarball: 'file:a.tgz' },
    ],
    [
      'git-hosted source',
      { tarball: url, gitHosted: true, integrity: hash },
      { tarball: url, gitHosted: true },
    ],
  ])('keeps %s in the ordinary graph comparison', (_case, before, after) => {
    const report = explain(scenario(before), scenario(after));
    expect(report.tarballIntegrity.changes).toEqual([]);
    expect(renderText(report)).not.toContain('Tarball integrity losses');
    if (JSON.stringify(before) !== JSON.stringify(after))
      expect(
        report.changes.some(
          (change) => change.kind === 'package' && change.name === 'a',
        ),
      ).toBe(true);
  });

  it('does not pair different package keys for the same tarball', () => {
    const report = explain(
      scenario({ tarball: url, integrity: hash }, { url: `${url}?source=base-secret` }),
      scenario({ tarball: url }, { url: `${url}?source=head-secret` }),
    );
    expect(report.tarballIntegrity.changes).toEqual([]);
    const rendered = renderJson(report);
    expect(rendered).not.toMatch(/(?:base|head)-secret/);
    const change = JSON.parse(rendered).changes.find(
      (item: { kind: string }) => item.kind === 'package',
    );
    expect(change.changedNodes.base[0]).not.toBe(change.changedNodes.head[0]);
  });

  it('reports one loss for a package row shared by several URL snapshots', () => {
    const tarball = 'https://example.test/a(release).tgz';
    const otherReference = `${tarball}(peer@1.0.0)`;
    const options = { url: tarball, otherReference };
    const { changes } = explain(
      scenario({ tarball, integrity: hash }, options),
      scenario({ tarball }, options),
    ).tarballIntegrity;
    expect(changes).toHaveLength(1);
    expect(
      changes[0]!.head.instances.map(({ id, consumers }) => [
        id,
        consumers.map(({ workspace }) => workspace),
      ]),
    ).toEqual([
      [`a@${tarball}`, [direct, transitive]],
      [`a@${otherReference}`, [other]],
    ]);
    expect(changes[0]!.head.instances[1]!.consumers[0]!.uncertainty).toContain(
      `a@${otherReference}: peer context (peer@1.0.0)`,
    );
  });

  it.each([
    [{ otherReference: 'missing@1.0.0' }, 'Unresolved dependency'],
    [
      { otherReference: `${url}(peer@1.0.0)`, ambiguous: true },
      'Ambiguous package metadata',
    ],
  ] as const)('keeps known paths in a partial graph (%s)', (options, warning) => {
    const report = explain(
      scenario({ tarball: url, integrity: hash }),
      scenario({ tarball: url }, options),
    );
    const [change] = report.tarballIntegrity.changes;
    expect(report.tarballIntegrity.changes).toHaveLength(1);
    expect(change!.head.coverage).toBe('partial');
    expect(
      change!.head.instances.flatMap(({ consumers }) =>
        consumers.map(({ workspace }) => workspace),
      ),
    ).toEqual([direct, transitive]);
    expect(report.warnings.some((item) => item.includes(warning))).toBe(true);
    expect(renderText(report)).toContain(
      'head workspace consumers (coverage: partial)',
    );
  });

  it('reports the loss when the head package row has no snapshot', () => {
    const report = explain(
      scenario({ tarball: url, integrity: hash }),
      scenario({ tarball: url }, { noSnapshot: true }),
    );
    expect(report.tarballIntegrity.changes[0]?.head).toMatchObject({
      coverage: 'partial',
      instances: [],
    });
    expect(renderText(report)).toContain(
      'No snapshot is linked to this package entry.',
    );
  });

  it('redacts URL credentials, query and fragment everywhere in both reports', () => {
    const sensitive =
      'https://lab-user:lab-pass@example.test/a.tgz?signature=lab-token#lab-fragment';
    const report = explain(
      scenario({ tarball: sensitive, integrity: hash }, { url: sensitive }),
      scenario({ tarball: sensitive }, { url: sensitive, otherReference: sensitive }),
    );
    const json = renderJson(report);
    for (const rendered of [renderText(report), json]) {
      expect(rendered).toContain('https://example.test/a.tgz?[redacted-');
      for (const secret of ['lab-user', 'lab-pass', 'lab-token', 'lab-fragment'])
        expect(rendered).not.toContain(secret);
    }
    const parsed = JSON.parse(json);
    const change = parsed.tarballIntegrity.changes[0];
    expect(change.packageKey).toBe(change.head.instances[0].consumers[0].path.at(-1));
    expect(renderText(report)).toContain(`metadata [${change.packageKey}]`);
    const pathIds = parsed.changes.flatMap((item: { evidence: { pathId: string }[] }) =>
      item.evidence.map((evidence) => evidence.pathId),
    );
    expect(pathIds.length).toBeGreaterThan(0);
    for (const id of pathIds) expect(parsed.pathNodes[id]).toBeDefined();
  });
});
