import { type FastifyPluginAsync, type onRequestAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from '../db/schema/index.js';
import { type Db } from '../db/client.js';
import { setCompanyContext } from '../db/rls.js';
import { UnauthorizedError } from '../lib/errors.js';

// request.tx — транзакция домена: держит один pg-client в BEGIN/COMMIT
// на всё время обработки запроса. Открывается withCompanyContext preHandler'ом,
// закрывается onResponse-хуком (COMMIT) или onError (ROLLBACK).
declare module 'fastify' {
  interface FastifyRequest {
    tx?: Db;
  }
  interface FastifyInstance {
    // Готовый preHandler: требует request.ctx (auth должен отработать раньше),
    // открывает tx под ctx.companyId, кладёт в request.tx.
    withCompanyContext: onRequestAsyncHookHandler;
  }
}

// Внутренние ключи request — хранят живой pg client + коммит/rollback колбеки,
// не публичны в FastifyRequest.
const CLIENT_KEY = Symbol('smt.pg.client');
const RELEASED_KEY = Symbol('smt.pg.released');

type InternalReq = {
  [CLIENT_KEY]?: pg.PoolClient;
  [RELEASED_KEY]?: boolean;
};

const withCompanyContextPlugin: FastifyPluginAsync = async (app) => {
  // Достаём пул из низкоуровневого клиента. Приложение может ходить в db через
  // Drizzle с пулом (для чтения), но домен-транзакции требуют явного соединения,
  // держим его через .connect().
  //
  // Пул уже создан db-плагином. Достаём его через app.db.
  // Drizzle instance держит ссылку на pg-Pool в свойстве .$client.
  const getPool = (): pg.Pool => {
    const client = (app.db as unknown as { $client: pg.Pool }).$client;
    if (!client) throw new Error('db plugin не инициализирован');
    return client;
  };

  const withCompanyContext: onRequestAsyncHookHandler = async (request) => {
    const ctx = request.ctx;
    if (!ctx) throw new UnauthorizedError();

    const client = await getPool().connect();
    const internal = request as unknown as InternalReq;
    internal[CLIENT_KEY] = client;
    internal[RELEASED_KEY] = false;

    try {
      await client.query('BEGIN');
      const tx: Db = drizzle(client, { schema }) as unknown as Db;
      await setCompanyContext(tx, ctx.companyId);
      request.tx = tx;
    } catch (err) {
      // Не смогли открыть транзакцию — откатим и вернём клиент в пул.
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK может сам упасть если connection битый — ничего не делаем,
        // release ниже вернёт коннект в пул с force=true.
      }
      client.release(true);
      internal[RELEASED_KEY] = true;
      throw err;
    }
  };

  // COMMIT + release после успешного ответа.
  app.addHook('onResponse', async (request) => {
    const internal = request as unknown as InternalReq;
    const client = internal[CLIENT_KEY];
    if (!client || internal[RELEASED_KEY]) return;

    try {
      await client.query('COMMIT');
    } catch (err) {
      request.log.error({ err }, 'ошибка при COMMIT доменной транзакции');
      try {
        await client.query('ROLLBACK');
      } catch {
        // см. выше — release с force=true покроет.
      }
    } finally {
      client.release();
      internal[RELEASED_KEY] = true;
    }
  });

  // ROLLBACK + release при ошибке.
  app.addHook('onError', async (request) => {
    const internal = request as unknown as InternalReq;
    const client = internal[CLIENT_KEY];
    if (!client || internal[RELEASED_KEY]) return;

    try {
      await client.query('ROLLBACK');
    } catch (err) {
      request.log.warn({ err }, 'ошибка при ROLLBACK доменной транзакции');
    } finally {
      client.release();
      internal[RELEASED_KEY] = true;
    }
  });

  app.decorate('withCompanyContext', withCompanyContext);
};

export default fp(withCompanyContextPlugin, {
  name: 'with-company-context',
  dependencies: ['db'],
});

// Хелпер для использования вне HTTP (тесты, background jobs, скрипты миграции данных):
// открывает транзакцию, ставит контекст компании, выполняет callback, коммитит.
// При ошибке — rollback.
export const runInCompanyContext = async <T>(
  db: Db,
  companyId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> => {
  return db.transaction(async (tx) => {
    await setCompanyContext(tx as unknown as Db, companyId);
    return fn(tx as unknown as Db);
  }) as Promise<T>;
};

// Хелпер для системных запросов (auth flow, миграция данных) без контекста компании.
// НЕ используется для доменных таблиц — там RLS вернёт 0 строк.
// Применяется для чтения users/companies (глобальные таблицы без RLS).
export const runWithoutCompanyContext = async <T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
): Promise<T> => {
  return db.transaction((tx) => fn(tx as unknown as Db)) as Promise<T>;
};

// Экспорт исходной transactionless Db-обёртки: сам объект NodePgDatabase.
// Внутри используем в generics ниже.
export type _NodePgDb = NodePgDatabase<typeof schema>;
