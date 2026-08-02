import { query } from '@tollgate/db';
import type { Catalog } from './catalog.js';
import type { ProviderBinding } from './providers.js';

export function routeBindings(catalog: Catalog, random = Math.random): ProviderBinding[] {
  const candidates = [...catalog.bindings];
  if (catalog.strategy === 'cheapest')
    return candidates.sort((a, b) =>
      Number(
        (a.inputCostPerMtok ?? 0n) +
          (a.outputCostPerMtok ?? 0n) -
          ((b.inputCostPerMtok ?? 0n) + (b.outputCostPerMtok ?? 0n)),
      ),
    );
  if (catalog.strategy === 'lowest_latency')
    return candidates.sort(
      (a, b) =>
        (a.ewmaTtftMs ?? Number.MAX_SAFE_INTEGER) - (b.ewmaTtftMs ?? Number.MAX_SAFE_INTEGER),
    );
  if (catalog.strategy === 'weighted') {
    return candidates
      .map((binding) => ({
        binding,
        score: -Math.log(Math.max(Number.EPSILON, random())) / Math.max(1, binding.weight ?? 1),
      }))
      .sort((a, b) => a.score - b.score)
      .map(({ binding }) => binding);
  }
  return candidates.sort((a, b) => a.priority - b.priority);
}

export async function recordProviderResult(
  bindingId: string | undefined,
  ok: boolean,
  ttftMs?: number,
) {
  if (!bindingId) return;
  await query(
    `INSERT INTO provider_health(binding_id,ewma_ttft_ms,ewma_error_rate,consecutive_failures,breaker_state,opened_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(binding_id) DO UPDATE SET ewma_ttft_ms=CASE WHEN $2::numeric IS NULL THEN provider_health.ewma_ttft_ms ELSE COALESCE(provider_health.ewma_ttft_ms,$2)*0.8+$2*0.2 END,ewma_error_rate=provider_health.ewma_error_rate*0.8+$3*0.2,consecutive_failures=CASE WHEN $3=0 THEN 0 ELSE provider_health.consecutive_failures+1 END,breaker_state=CASE WHEN provider_health.consecutive_failures+1>=3 AND $3=1 THEN 'open' ELSE 'closed' END,opened_at=CASE WHEN provider_health.consecutive_failures+1>=3 AND $3=1 THEN now() ELSE NULL END,updated_at=now()`,
    [bindingId, ttftMs ?? null, ok ? 0 : 1, ok ? 0 : 1, ok ? 'closed' : 'closed', null],
  );
}
