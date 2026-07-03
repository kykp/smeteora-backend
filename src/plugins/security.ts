import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// Глобальный rate limit — защита от очевидного flood'а. Более жёсткие лимиты
// на auth-роутах задаются в route config (см. modules/auth/routes.ts).
const GLOBAL_RATE_MAX = 300;
const GLOBAL_RATE_WINDOW = '1 minute';

const securityPlugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie, {
    secret: app.config.SESSION_SECRET,
  });

  await app.register(cors, {
    origin: app.config.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(helmet, {
    // Для API минимальный CSP. Для HTML-фронта CSP настраивается на стороне фронта.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // В test-окружении rate-limit не нужен и мешает — тесты гоняют десятки
  // регистраций/логинов подряд за секунды и упираются в 5/мин.
  const isTest = app.config.NODE_ENV === 'test';

  await app.register(rateLimit, {
    global: true,
    max: isTest ? Number.MAX_SAFE_INTEGER : GLOBAL_RATE_MAX,
    timeWindow: GLOBAL_RATE_WINDOW,
  });
};

export default fp(securityPlugin, { name: 'security', dependencies: [] });
