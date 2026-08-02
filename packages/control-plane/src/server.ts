import { buildControlPlane } from './app.js';
import { loadConfig } from '@tollgate/shared';

const config = loadConfig();
const app = buildControlPlane();
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
await app.listen({ host: config.HOST, port: config.PORT });
