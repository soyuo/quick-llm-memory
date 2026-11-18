import { z } from 'zod';

export const settingsSchema = z
  .object({
    logging: z
      .object({
        level: z
          .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
          .default('info'),
      })
      .default({ level: 'info' }),
    ai: z
      .object({
        provider: z.enum(['openai', 'openai-compatible']).default('openai'),
        model: z.string().trim().min(1).optional(),
        embedding_model: z.string().trim().min(1).default('text-embedding-3-small'),
        cache_generation: z.boolean().default(true),
      })
      .passthrough()
      .optional(),
    mcp: z.object({
      permissions: z.array(z.enum(['READ', 'SEARCH', 'METADATA', 'PROPOSE_WRITE', 'APPROVED_WRITE', 'ADMIN'])).default(['READ', 'SEARCH', 'METADATA']),
    }).default({ permissions: ['READ', 'SEARCH', 'METADATA'] }),
  })
  .passthrough();

export type Settings = z.infer<typeof settingsSchema>;
