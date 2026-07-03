import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Config } from './config.js';
import dbPlugin from './plugins/db.js';
import { healthRoutes } from './routes/health.js';

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

  await app.register(dbPlugin);
  await app.register(healthRoutes);

  return app;
};
