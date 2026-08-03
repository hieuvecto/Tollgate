export class TollgateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const openAiError = (error: TollgateError) => ({
  error: { message: error.message, type: 'tollgate_error', param: null, code: error.code },
});
