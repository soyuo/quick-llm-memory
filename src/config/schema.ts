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
  })
  .passthrough();

export type Settings = z.infer<typeof settingsSchema>;
