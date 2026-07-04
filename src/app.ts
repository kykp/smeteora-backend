import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Config } from './config.js';
import { DomainError } from './lib/errors.js';
import dbPlugin from './plugins/db.js';
import securityPlugin from './plugins/security.js';
import authPlugin from './plugins/auth.js';
import withCompanyContextPlugin from './plugins/with-company-context.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './modules/auth/routes.js';
import { projectsRoutes } from './modules/projects/routes.js';
import { invitationsRoutes } from './modules/invitations/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'res.headers["set-cookie"]',
] as const;

const API_V1_PREFIX = '/api/v1';

export const buildApp = async (config: Config): Promise<FastifyInstance> => {
  const isDev = config.NODE_ENV === 'development';

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, colorize: true, translateTime: 'HH:MM:ss' },
            },
          }
        : {}),
    },
    disableRequestLogging: false,
    trustProxy: !isDev,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', config);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // DomainError — типизированная ошибка домена. Отдаём её code + message как есть.
    if (error instanceof DomainError) {
      request.log.warn(
        { err: error, code: error.code, statusCode: error.statusCode },
        'ошибка домена',
      );
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    // Zod-validation ошибки от fastify-type-provider-zod прилетают со statusCode=400.
    const status = error.statusCode ?? 500;
    const isServerError = status >= 500;

    if (isServerError) {
      request.log.error({ err: error }, 'необработанная ошибка запроса');
    } else {
      request.log.warn({ err: error, statusCode: status }, 'ошибка запроса (4xx)');
    }

    const isProd = config.NODE_ENV === 'production';
    void reply.status(status).send({
      error: {
        code: isServerError ? 'internal_error' : (error.code ?? 'bad_request'),
        message: isServerError && isProd ? 'Внутренняя ошибка сервера' : error.message,
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: 'Ресурс не найден' },
    });
  });

  // Порядок регистрации важен: security → db → auth → withCompanyContext.
  // Auth-плагин требует и cookie (из security) и db.
  await app.register(securityPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(withCompanyContextPlugin);

  // Системный роут — вне /api/v1/ префикса.
  await app.register(healthRoutes);

  // Доменные роуты — под /api/v1/*.
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(projectsRoutes, { prefix: '/projects' });
      await v1.register(invitationsRoutes, { prefix: '/invitations' });
    },
    { prefix: API_V1_PREFIX },
  );

  return app;
};
