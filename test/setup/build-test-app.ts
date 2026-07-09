import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOverrides } from '../../src/app.js';
import { type Config } from '../../src/config.js';

// Строит Fastify-инстанс с тестовой конфигурацией.
// В отличие от прод-версии — не читает env, не запускает listen.
// Тест использует fastify.inject() для симуляции HTTP-запросов без реального сокета.
export const buildTestApp = async (overrides: BuildAppOverrides = {}): Promise<FastifyInstance> => {
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
    // Тестовый Yandex-стаб URL, реально не используются (клиент замокан).
    FRONTEND_OAUTH_SUCCESS_URL: 'http://localhost:5173/',
    FRONTEND_OAUTH_ERROR_URL: 'http://localhost:5173/auth/error',
    YANDEX_OAUTH_CLIENT_ID: 'test-client-id',
    YANDEX_OAUTH_CLIENT_SECRET: 'test-client-secret',
    YANDEX_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/yandex/callback',
    // Уникальная temp-директория на инстанс приложения — тесты не должны
    // подмешивать логотипы друг другу через общую директорию.
    UPLOADS_DIR: mkdtempSync(join(tmpdir(), 'smeteora-uploads-')),
    // Email OTP — в тестах письма пишутся в лог (console-sender), реальный SMTP
    // не поднимается.
    MAIL_TRANSPORT: 'console',
    MAIL_FROM: 'Smeteora Test <no-reply@test.smeteora.ru>',
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    SMTP_SECURE: false,
    EMAIL_OTP_TTL_MINUTES: 10,
  });

  return buildApp(config, overrides);
};
