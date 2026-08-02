import pino from 'pino';

export const createLogger = () =>
  pino({
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        '*.plaintext',
        '*.prompt',
        '*.messages',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request: { method?: string; url?: string; id?: string }) {
        return { method: request.method, url: request.url, id: request.id };
      },
    },
  });
