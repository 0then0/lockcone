import { z } from 'zod';

export const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;
export type Section = (typeof sections)[number];
const dependencies = z.record(z.string(), z.string()).default({});
const manifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    dependencies,
    devDependencies: dependencies,
    optionalDependencies: dependencies,
    peerDependencies: dependencies,
    pnpm: z.unknown().optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(source: string, path: string): Manifest {
  try {
    return manifestSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`Invalid manifest ${path}: ${String(error)}`);
  }
}
