import { z } from 'zod';

const frontmatterBaseSchema = {
  id: z.string().min(1),
  title: z.string().min(1),
  depth: z.number().int().min(1),
};

const generationSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    revision: z.number().int().min(1),
    baseline_hash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  })
  .strict();

export const documentFrontmatterSchema = z
  .object({
    schema_version: z.literal(1),
    ...frontmatterBaseSchema,
    type: z.literal('document'),
    status: z.string().min(1),
    description: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    source_ids: z.array(z.string().min(1)).optional(),
    source_sections: z.array(z.string().min(1)).optional(),
    related: z.array(z.string().min(1)).optional(),
    created_at: z.iso.datetime().optional(),
    updated_at: z.iso.datetime().optional(),
    generation: generationSchema.optional(),
  })
  .strict();

export const documentDraftFrontmatterSchema = documentFrontmatterSchema.omit({
  id: true,
});

export const categoryIndexFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    depth: z.number().int().min(0),
    type: z.literal('category-index'),
  })
  .strict();

export type DocumentFrontmatter = z.infer<typeof documentFrontmatterSchema>;
export type DocumentDraftFrontmatter = z.infer<
  typeof documentDraftFrontmatterSchema
>;
export type CategoryIndexFrontmatter = z.infer<
  typeof categoryIndexFrontmatterSchema
>;
export type MarkdownFrontmatter =
  | DocumentFrontmatter
  | CategoryIndexFrontmatter;
