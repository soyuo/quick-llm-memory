import { InputError } from '../errors/qlm-error.js';
import { z } from 'zod';

const windowsReservedNames = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export const projectNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  .refine((name) => !windowsReservedNames.has(name));

export const projectMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().uuid(),
    name: projectNameSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export function validateProjectName(name: string): string {
  const result = projectNameSchema.safeParse(name);
  if (!result.success) {
    throw new InputError('Invalid project name.', {
      suggestedAction:
        'Use 1–64 lowercase letters, digits, and hyphens; start and end with a letter or digit, and avoid reserved Windows names.',
    });
  }

  return result.data;
}
