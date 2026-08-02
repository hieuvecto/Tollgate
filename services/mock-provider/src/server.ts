import { buildMockProvider } from './app.js';
const app = buildMockProvider();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4010) });
