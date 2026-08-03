import { query } from '@tollgate/db';
import {
  decodeProviderCredentialKek,
  loadConfig,
  openSecret,
  TollgateError,
  type SealedSecret,
} from '@tollgate/shared';
import type { ProviderBinding } from './providers.js';
import { redis } from './auth.js';

const config = loadConfig();
const providerCredentialKek = config.PROVIDER_CREDENTIAL_KEK
  ? decodeProviderCredentialKek(config.PROVIDER_CREDENTIAL_KEK)
  : undefined;

function withoutCredential(binding: ProviderBinding): ProviderBinding {
  const cacheable = { ...binding };
  delete cacheable.credential;
  return cacheable;
}

export interface Catalog {
  modelId: string;
  publicName: string;
  defaultMaxOutput: number;
  pricingId: string;
  inputPrice: bigint;
  outputPrice: bigint;
  cachedPrice: bigint;
  bindings: ProviderBinding[];
  rpm: number;
  tpm: number;
  strategy: 'cheapest' | 'lowest_latency' | 'weighted' | 'failover_order';
}

async function loadCatalogFromDb(orgId: string, model: string): Promise<Catalog> {
  const rows = await query<Record<string, unknown>>(
    `SELECT m.id model_id,m.public_name,m.default_max_output_tokens,p.id pricing_id,p.input_per_mtok,p.output_per_mtok,p.cached_input_per_mtok,r.rpm_limit,r.tpm_limit,r.strategy FROM models m JOIN model_pricing p ON p.model_id=m.id AND p.effective_from<=now() AND (p.effective_to IS NULL OR p.effective_to>now()) LEFT JOIN routing_policies r ON r.org_id=$1 WHERE m.public_name=$2`,
    [orgId, model],
  );
  const row = rows.rows[0];
  if (!row) throw new TollgateError(404, 'model_not_found', `Unknown model: ${model}`);
  const bindings = await query<Record<string, unknown>>(
    `SELECT pb.id binding_id,p.id provider_id,p.kind,p.base_url,pb.provider_model_name,pb.priority,pb.weight,pb.input_cost_per_mtok,pb.output_cost_per_mtok,h.ewma_ttft_ms,h.breaker_state,h.opened_at,pc.encrypted_secret,pc.secret_iv,pc.secret_tag,pc.wrapped_dek,pc.wrap_iv,pc.wrap_tag,pc.key_version FROM provider_bindings pb JOIN providers p ON p.id=pb.provider_id LEFT JOIN provider_health h ON h.binding_id=pb.id LEFT JOIN provider_credentials pc ON pc.provider_id=p.id AND pc.org_id=$2 AND pc.status='active' WHERE pb.model_id=$1 AND pb.enabled AND p.enabled AND (h.breaker_state IS DISTINCT FROM 'open' OR h.opened_at < now()-interval '30 seconds') ORDER BY pb.priority`,
    [row.model_id, orgId],
  );
  if (!bindings.rowCount) {
    throw new TollgateError(503, 'provider_unavailable', 'No provider binding is available');
  }
  return {
    modelId: String(row.model_id),
    publicName: String(row.public_name),
    defaultMaxOutput: Number(row.default_max_output_tokens),
    pricingId: String(row.pricing_id),
    inputPrice: BigInt(String(row.input_per_mtok)),
    outputPrice: BigInt(String(row.output_per_mtok)),
    cachedPrice: BigInt(String(row.cached_input_per_mtok)),
    bindings: bindings.rows.map((item) => {
      const credentialRequired = item.encrypted_secret instanceof Buffer;
      let credential: string | undefined;
      if (credentialRequired) {
        if (!providerCredentialKek) {
          throw new TollgateError(
            503,
            'credential_decryption_unavailable',
            'Provider credential encryption is not configured',
          );
        }
        const sealed: SealedSecret = {
          ciphertext: (item.encrypted_secret as Buffer).toString('base64'),
          secretIv: (item.secret_iv as Buffer).toString('base64'),
          secretTag: (item.secret_tag as Buffer).toString('base64'),
          wrappedDek: (item.wrapped_dek as Buffer).toString('base64'),
          wrapIv: (item.wrap_iv as Buffer).toString('base64'),
          wrapTag: (item.wrap_tag as Buffer).toString('base64'),
          keyVersion: Number(item.key_version),
        };
        credential = openSecret(
          sealed,
          providerCredentialKek,
          `${orgId}:${String(item.provider_id)}`,
        );
      }
      return {
        bindingId: String(item.binding_id),
        providerId: String(item.provider_id),
        kind: String(item.kind),
        baseUrl: String(item.base_url),
        providerModel: String(item.provider_model_name),
        priority: Number(item.priority),
        weight: Number(item.weight),
        inputCostPerMtok: BigInt(String(item.input_cost_per_mtok)),
        outputCostPerMtok: BigInt(String(item.output_cost_per_mtok)),
        ewmaTtftMs: item.ewma_ttft_ms === null ? null : Number(item.ewma_ttft_ms),
        breakerState: typeof item.breaker_state === 'string' ? item.breaker_state : 'closed',
        credentialRequired,
        ...(credential ? { credential } : {}),
      };
    }),
    rpm: Number(row.rpm_limit ?? 60),
    tpm: Number(row.tpm_limit ?? 100000),
    strategy:
      typeof row.strategy === 'string' ? (row.strategy as Catalog['strategy']) : 'failover_order',
  };
}

export async function loadCatalog(orgId: string, model: string): Promise<Catalog> {
  const cacheKey = `catalog:${orgId}:${model}`;
  try {
    const catalog = await loadCatalogFromDb(orgId, model);
    const cacheable = {
      ...catalog,
      bindings: catalog.bindings.map(withoutCredential),
    };
    await redis.set(
      cacheKey,
      JSON.stringify(cacheable, (key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      'EX',
      15,
    );
    return catalog;
  } catch (error) {
    const cached = await redis.get(cacheKey);
    if (!cached) throw error;
    const value = JSON.parse(cached) as Omit<
      Catalog,
      'inputPrice' | 'outputPrice' | 'cachedPrice' | 'bindings'
    > & {
      inputPrice: string;
      outputPrice: string;
      cachedPrice: string;
      bindings: Array<
        Omit<ProviderBinding, 'inputCostPerMtok' | 'outputCostPerMtok'> & {
          inputCostPerMtok?: string;
          outputCostPerMtok?: string;
        }
      >;
    };
    const restoredBindings = value.bindings
      .filter((binding) => !binding.credentialRequired)
      .map(({ inputCostPerMtok, outputCostPerMtok, ...binding }) => ({
        ...binding,
        ...(inputCostPerMtok === undefined ? {} : { inputCostPerMtok: BigInt(inputCostPerMtok) }),
        ...(outputCostPerMtok === undefined
          ? {}
          : { outputCostPerMtok: BigInt(outputCostPerMtok) }),
      }));
    if (!restoredBindings.length) {
      throw new TollgateError(
        503,
        'provider_unavailable',
        'No provider binding is available without credential storage',
      );
    }
    return {
      ...value,
      inputPrice: BigInt(value.inputPrice),
      outputPrice: BigInt(value.outputPrice),
      cachedPrice: BigInt(value.cachedPrice),
      bindings: restoredBindings,
    };
  }
}

export const estimateTokens = (value: unknown): number =>
  Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
