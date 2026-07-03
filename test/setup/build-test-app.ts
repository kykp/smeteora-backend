import { type FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { type Config } from '../../src/config.js';

// Строит Fastify-инстанс с тестовой конфигурацией.
// В отличие от прод-версии — не читает env, не запускает listen.
// Тест использует fastify.inject() для симуляции HTTP-запросов без реального сокета.
export const buildTestApp = async (): Promise<FastifyInstance> => {
  const config: Config = Object.freeze({
    PORT: 0,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    CORS_ORIGIN: ['http://localhost:5173'],
    DATABASE_URL:
      process.env['DATABASE_URL_TEST'] ??
      'postgresql://smeteora_app:app_test_password@localhost:5433/smeteora_test',
    SESSION_SECRET: 'test_secret_at_least_32_characters_long_ok',
    SESSION_TTL_DAYS: 30,
    version: '0.0.1-test',
    COOKIE_DOMAIN: undefined,
  });

  return buildApp(config);
};
