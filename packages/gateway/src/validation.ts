import { z } from 'zod';
import { TollgateError, type ChatCompletionRequest } from '@tollgate/shared';

const messageSchema = z
  .object({
    role: z.string().min(1),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

const chatCompletionSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const embeddingSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(z.unknown()).min(1)]),
  })
  .passthrough();

function invalidRequest(error: z.ZodError): TollgateError {
  const issue = error.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  return new TollgateError(
    400,
    'invalid_request_error',
    `Invalid request${location}: ${issue?.message ?? 'body does not match the API contract'}`,
  );
}

export function parseChatCompletion(value: unknown): ChatCompletionRequest {
  const parsed = chatCompletionSchema.safeParse(value);
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data as ChatCompletionRequest;
}

export function parseEmbedding(value: unknown): Record<string, unknown> & {
  model: string;
  input: string | unknown[];
} {
  const parsed = embeddingSchema.safeParse(value);
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}
