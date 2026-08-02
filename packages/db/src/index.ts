import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig } from '@tollgate/shared';

let singleton: Pool | undefined;
export const pool = (): Pool =>
  (singleton ??= new Pool({ connectionString: loadConfig().DATABASE_URL }));
export const query = <T extends QueryResultRow>(text: string, values: unknown[] = []) =>
  pool().query<T>(text, values);

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
