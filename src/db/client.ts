import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

const DEFAULT_POOL_SIZE = 20;

export type Db = NodePgDatabase<typeof schema>;

export interface DbClient {
  readonly db: Db;
  readonly pool: pg.Pool;
  end: () => Promise<void>;
}

export const createDbClient = (databaseUrl: string): DbClient => {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: DEFAULT_POOL_SIZE,
    // Держим коннекты живыми — Fastify обрабатывает много коротких запросов.
    idleTimeoutMillis: 30_000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    end: () => pool.end(),
  };
};
