import { z } from 'zod';

const frontmatterBaseSchema = {
  id: z.string().min(1),
  title: z.string().min(1),
  depth: z.number().int().min(0),
};

export const documentFrontmatterSchema = z
  .object({
    schema_version: z.literal(1),
    ...frontmatterBaseSchema,
    type: z.literal('document'),
    status: z.string().min(1),
  })
  .passthrough();

export const categoryIndexFrontmatterSchema = z
  .object({
    ...frontmatterBaseSchema,
    type: z.literal('category-index'),
  })
  .passthrough();

export type DocumentFrontmatter = z.infer<typeof documentFrontmatterSchema>;
export type CategoryIndexFrontmatter = z.infer<
  typeof categoryIndexFrontmatterSchema
>;
export type MarkdownFrontmatter =
  | DocumentFrontmatter
  | CategoryIndexFrontmatter;
