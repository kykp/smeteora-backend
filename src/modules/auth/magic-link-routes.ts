import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../lib/session-cookie.js';
import { startMagicLink, verifyMagicLink } from './magic-link-service.js';

// Публичные схемы — минимальный контракт. Держим локально: экспорт в shared
// не нужен, потому что фронт кроме отправки POST /start ничего не делает,
// а /verify — GET-редирект.

const startBodySchema = z.object({
  email: z.string().trim().email('Некорректный email').max(320),
});

// 202 Accepted — семантически «принято, но результат не гарантирован». Никакой
// информации о том, был ли email найден в БД, наружу не отдаём: enumeration.
const startResponseSchema = z.object({
  ok: z.literal(true),
});

const verifyQuerySchema = z.object({
  token: z.string().trim().min(1),
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

export const magicLinkRoutes: FastifyPluginAsyncZod = async (app) => {
  const sessionCookieOpts = sessionCookieOptions(app.config);

  // ── POST /auth/magic-link/start ──
  // Принимает email, шлёт письмо со ссылкой. Не раскрывает, был ли email
  // зарегистрирован — 202 всегда одинаковый.
  //
  // Rate-limit: пять запросов в минуту на IP (fastify-rate-limit),
  // плюс жёсткий лимит N активных ссылок на email в service.
  app.post(
    '/magic-link/start',
    {
      schema: {
        body: startBodySchema,
        response: { 202: startResponseSchema },
        tags: ['auth'],
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const meta = extractMeta(request);
      await startMagicLink(
        app.db,
        app.email,
        app.config.FRONTEND_MAGIC_LINK_URL,
        app.config.MAGIC_LINK_TTL_MINUTES,
        {
          email: request.body.email,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      );
      void reply.status(202);
      return { ok: true as const };
    },
  );

  // ── GET /auth/magic-link/verify ──
  // Юзер попал сюда по ссылке из письма. Ставим session cookie и редиректим
  // на success URL (тот же, что у Yandex OAuth). Ошибки — на error URL с
  // ?error=magic_link_invalid, чтобы фронт мог показать читаемое сообщение.
  app.get(
    '/magic-link/verify',
    {
      schema: {
        querystring: verifyQuerySchema,
        tags: ['auth'],
      },
    },
    async (request, reply) => {
      const successUrl = app.config.FRONTEND_OAUTH_SUCCESS_URL;
      const errorUrl = app.config.FRONTEND_OAUTH_ERROR_URL;

      const failWith = (reason: string): void => {
        request.log.warn({ reason }, 'magic-link: verify failed');
        if (!errorUrl) {
          void reply.status(400).send({
            error: { code: reason, message: 'Ссылка недействительна или уже использована' },
          });
          return;
        }
        const url = new URL(errorUrl);
        url.searchParams.set('error', reason);
        void reply.redirect(url.toString(), 302);
      };

      const meta = extractMeta(request);
      try {
        const result = await verifyMagicLink(app.db, {
          token: request.query.token,
          ip: meta.ip,
          userAgent: meta.userAgent,
          sessionTtlDays: app.config.SESSION_TTL_DAYS,
        });
        request.log.info(
          { userId: result.userId, isNewUser: result.isNewUser },
          'magic-link: verify успешен',
        );

        void reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOpts);
        if (!successUrl) {
          void reply.status(200).send({ ok: true, isNewUser: result.isNewUser });
          return;
        }
        void reply.redirect(successUrl, 302);
      } catch (err) {
        // UnauthorizedError → magic_link_invalid; всё остальное — server_error.
        const code =
          err && typeof err === 'object' && 'code' in err && err.code === 'unauthorized'
            ? 'magic_link_invalid'
            : 'server_error';
        if (code === 'server_error') {
          request.log.error({ err }, 'magic-link: необработанная ошибка verify');
        }
        failWith(code);
      }
    },
  );
};
