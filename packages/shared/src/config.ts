import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://tollgate:tollgate@localhost:5432/tollgate'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  KEY_PEPPER: z.string().min(16).default('local-only-pepper-change-me'),
  MOCK_PROVIDER_URL: z.string().url().default('http://localhost:4010'),
  POLICY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  TTFT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  TOTAL_STREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(512),
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (overrides: NodeJS.ProcessEnv = process.env): Config =>
  schema.parse(overrides);
