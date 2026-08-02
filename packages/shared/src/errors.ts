export class TollgateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const openAIError = (error: TollgateError) => ({
  error: { message: error.message, type: 'tollgate_error', param: null, code: error.code },
});
