import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../lib/session-cookie.js';
import { startEmailOtp, verifyEmailOtp } from './email-otp-service.js';
import { authUserResponseSchema } from './schema.js';

// Публичные схемы — минимальный контракт. Держим локально: экспорт в shared
// не нужен, потому что фронт делает только POST /start и POST /verify.

const EMAIL_MAX_LENGTH = 254;

const startBodySchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).email('Некорректный email'),
});

// 202 Accepted — семантически «принято, но результат не гарантирован». Никакой
// информации о том, был ли email найден в БД, наружу не отдаём: enumeration.
const startResponseSchema = z.object({
  ok: z.literal(true),
});

// Код всегда 6 цифр. Заранее фильтруем на роуте: с кривой длиной / буквами
// не идём в БД.
const verifyBodySchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).email('Некорректный email'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Код — 6 цифр'),
});

const extractMeta = (request: {
  ip: string;
  headers: Record<string, unknown>;
}): { ip: string | null; userAgent: string | null } => {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
};

export const emailOtpRoutes: FastifyPluginAsyncZod = async (app) => {
  const sessionCookieOpts = sessionCookieOptions(app.config);
  const isTest = app.config.NODE_ENV === 'test';

  // ── POST /auth/otp/start ──
  // Принимает email, шлёт письмо с 6-значным кодом. Не раскрывает, был ли
  // email зарегистрирован — 202 всегда одинаковый.
  //
  // Rate-limit: пять запросов в минуту на IP (fastify-rate-limit),
  // плюс жёсткий лимит N активных кодов на email в service.
  app.post(
    '/otp/start',
    {
      schema: {
        body: startBodySchema,
        response: { 202: startResponseSchema },
        tags: ['auth'],
      },
      config: {
        rateLimit: {
          max: isTest ? Number.MAX_SAFE_INTEGER : 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const meta = extractMeta(request);
      await startEmailOtp(app.db, app.email, app.config.EMAIL_OTP_TTL_MINUTES, {
        email: request.body.email,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      void reply.status(202);
      return { ok: true as const };
    },
  );

  // ── POST /auth/otp/verify ──
  // Юзер ввёл код из письма. Ставим session cookie и возвращаем /me-ответ.
  // Rate-limit тот же, что и на /start — защита от подбора кода.
  app.post(
    '/otp/verify',
    {
      schema: {
        body: verifyBodySchema,
        response: { 200: authUserResponseSchema },
        tags: ['auth'],
      },
      config: {
        rateLimit: {
          max: isTest ? Number.MAX_SAFE_INTEGER : 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const meta = extractMeta(request);
      const result = await verifyEmailOtp(app.db, {
        email: request.body.email,
        code: request.body.code,
        ip: meta.ip,
        userAgent: meta.userAgent,
        sessionTtlDays: app.config.SESSION_TTL_DAYS,
      });
      request.log.info(
        { userId: result.response.user.id, isNewUser: result.isNewUser },
        'email-otp: verify успешен',
      );
      void reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOpts);
      return result.response;
    },
  );
};
