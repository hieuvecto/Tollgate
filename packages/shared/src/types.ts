export type Role = 'owner' | 'admin' | 'member' | 'billing_viewer';
export type MeteringFailurePolicy = 'fail_open' | 'fail_closed';
export type RoutingStrategy = 'cheapest' | 'lowest_latency' | 'weighted' | 'failover_order';
export type UsageSource = 'provider' | 'estimated';

export interface UsageFact {
  requestId: string;
  orgId: string;
  teamId: string | null;
  apiKeyId: string;
  modelId: string;
  pricingId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  source: UsageSource;
  providerRaw: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content?: string | unknown[]; tool_calls?: unknown[] }>;
  stream?: boolean;
  max_tokens?: number;
  tools?: unknown[];
  stream_options?: { include_usage?: boolean };
}
