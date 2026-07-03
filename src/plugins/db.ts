import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';
import { createDbClient, type Db } from '../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

// Плагин подключения к БД. Регистрирует decorator app.db и graceful shutdown pool'а.
// Использует роль smeteora_app из DATABASE_URL — БЕЗ BYPASSRLS.
const dbPlugin: FastifyPluginAsync = async (app) => {
  const client = createDbClient(app.config.DATABASE_URL);

  app.decorate('db', client.db);

  app.addHook('onClose', async () => {
    await client.end();
  });
};

export default fp(dbPlugin, { name: 'db' });
