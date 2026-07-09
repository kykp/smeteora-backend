import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { UnauthorizedError } from '../../lib/errors.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '../../lib/session-cookie.js';
import * as service from './service.js';
import {
  authUserResponseSchema,
  changePasswordBodySchema,
  loginBodySchema,
  okResponseSchema,
  registerBodySchema,
  switchCompanyBodySchema,
  updateMeBodySchema,
} from './schema.js';
import { yandexAuthRoutes } from './yandex-routes.js';
import { emailOtpRoutes } from './email-otp-routes.js';

// Жёсткий rate limit на auth-роуты — защита от brute-force.
// В test-env выключается — интеграционные тесты за секунды делают десятки регистраций.
const AUTH_RATE_MAX = 5;
const AUTH_RATE_WINDOW = '1 minute';

// Извлечение метаданных запроса для аудита в session.
type MetaSource = { ip: string; headers: Record<string, unknown> };
const extractMeta = (request: MetaSource): { ip: string | null; userAgent: string | null } => {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
};

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const cookieOpts = sessionCookieOptions(app.config);
  const clearOpts = clearSessionCookieOptions(app.config);
  const isTest = app.config.NODE_ENV === 'test';
  const authRateLimit = {
    rateLimit: {
      max: isTest ? Number.MAX_SAFE_INTEGER : AUTH_RATE_MAX,
      timeWindow: AUTH_RATE_WINDOW,
    },
  } as const;

  app.post(
    '/register',
    {
      schema: {
        body: registerBodySchema,
        response: { 201: authUserResponseSchema },
        tags: ['auth'],
      },
      config: authRateLimit,
    },
    async (request, reply) => {
      const { email, password, companyName, userName } = request.body;
      const { sessionId, response } = await service.register(app.db, {
        email,
        password,
        companyName,
        ...(userName !== undefined ? { userName } : {}),
        sessionTtlDays: app.config.SESSION_TTL_DAYS,
        meta: extractMeta(request),
      });
      void reply.setCookie(SESSION_COOKIE_NAME, sessionId, cookieOpts).status(201);
      return response;
    },
  );

  app.post(
    '/login',
    {
      schema: {
        body: loginBodySchema,
        response: { 200: authUserResponseSchema },
        tags: ['auth'],
      },
      config: authRateLimit,
    },
    async (request, reply) => {
      const { sessionId, response } = await service.login(app.db, {
        ...request.body,
        sessionTtlDays: app.config.SESSION_TTL_DAYS,
        meta: extractMeta(request),
      });
      void reply.setCookie(SESSION_COOKIE_NAME, sessionId, cookieOpts);
      return response;
    },
  );

  app.post(
    '/logout',
    {
      schema: {
        response: { 200: okResponseSchema },
        tags: ['auth'],
      },
      onRequest: [app.authenticate],
    },
    async (request, reply) => {
      const ctx = request.ctx;
      if (!ctx) throw new UnauthorizedError();
      await service.logout(app.db, ctx.sessionId);
      void reply.clearCookie(SESSION_COOKIE_NAME, clearOpts);
      return { ok: true as const };
    },
  );

  app.get(
    '/me',
    {
      schema: {
        response: { 200: authUserResponseSchema },
        tags: ['auth'],
      },
      onRequest: [app.authenticate],
    },
    async (request) => {
      const ctx = request.ctx;
      if (!ctx) throw new UnauthorizedError();
      return service.me(app.db, {
        userId: ctx.userId,
        membershipId: ctx.membershipId,
      });
    },
  );

  app.patch(
    '/me',
    {
      schema: {
        body: updateMeBodySchema,
        response: { 200: authUserResponseSchema },
        tags: ['auth'],
      },
      onRequest: [app.authenticate],
    },
    async (request) => {
      const ctx = request.ctx;
      if (!ctx) throw new UnauthorizedError();
      return service.updateMe(app.db, {
        userId: ctx.userId,
        membershipId: ctx.membershipId,
        patch: { name: request.body.name },
      });
    },
  );

  app.post(
    '/change-password',
    {
      schema: {
        body: changePasswordBodySchema,
        response: { 200: okResponseSchema },
        tags: ['auth'],
      },
      // Rate-limit жёсткий как у логина — потенциальный вектор перебора текущего пароля.
      config: authRateLimit,
      onRequest: [app.authenticate],
    },
    async (request) => {
      const ctx = request.ctx;
      if (!ctx) throw new UnauthorizedError();
      await service.changePassword(app.db, {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/switch-company',
    {
      schema: {
        body: switchCompanyBodySchema,
        response: { 200: authUserResponseSchema },
        tags: ['auth'],
      },
      onRequest: [app.authenticate],
    },
    async (request) => {
      const ctx = request.ctx;
      if (!ctx) throw new UnauthorizedError();
      return service.switchCompany(app.db, {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        membershipId: request.body.membershipId,
      });
    },
  );

  // Yandex OAuth — под тем же /auth-префиксом что и остальные auth-роуты.
  // Отделён от email+password флоу, чтобы структура файлов не разрослась.
  await app.register(yandexAuthRoutes);
  await app.register(emailOtpRoutes);
};
