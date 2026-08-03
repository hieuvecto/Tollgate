export type MoneyMicros = bigint & { readonly moneyMicrosBrand: 'MoneyMicros' };
export const micros = (value: bigint): MoneyMicros => value as MoneyMicros;

export function priceTokens(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputPerMtok: bigint,
  outputPerMtok: bigint,
  cachedInputPerMtok: bigint,
): MoneyMicros {
  const regularInput = BigInt(Math.max(0, inputTokens - cachedInputTokens));
  const numerator =
    regularInput * inputPerMtok +
    BigInt(cachedInputTokens) * cachedInputPerMtok +
    BigInt(outputTokens) * outputPerMtok;
  return micros((numerator + 999_999n) / 1_000_000n);
}

export const moneyJson = (value: bigint): string => value.toString(10);
