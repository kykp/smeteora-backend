import { randomBytes } from 'node:crypto';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type CookieSerializeOptions } from '@fastify/cookie';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../lib/session-cookie.js';
import { upsertYandexIdentityAndCreateSession, YandexNoEmailError } from './yandex-service.js';
import { YandexOAuthError } from './yandex-client.js';

// Cookie с CSRF-state OAuth-флоу. Хранится HttpOnly signed, SameSite=Lax
// (Strict дропнется на cross-site редиректе с oauth.yandex.ru → callback).
const OAUTH_STATE_COOKIE = 'smt_oauth_state';
const OAUTH_STATE_TTL_SEC = 10 * 60; // 10 минут — с запасом на форму согласия в Яндексе.
const OAUTH_STATE_BYTES = 32;

const stateCookieOptions = (isProd: boolean): CookieSerializeOptions => ({
  httpOnly: true,
  secure: isProd,
  // Lax обязателен: cross-site редирект с oauth.yandex.ru должен донести cookie
  // до нашего /callback. Strict — не донесёт.
  sameSite: 'lax',
  path: '/',
  signed: true,
  maxAge: OAUTH_STATE_TTL_SEC,
});

const clearStateCookieOptions = (isProd: boolean): CookieSerializeOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/',
  maxAge: 0,
});

// Причины провала на callback — читаются фронтом как ?error=<code>.
const OAUTH_ERROR_CODES = {
  notConfigured: 'yandex_not_configured',
  stateMismatch: 'state_mismatch',
  yandexDenied: 'yandex_denied',
  yandexApi: 'yandex_api_error',
  noEmail: 'no_email',
  serverError: 'server_error',
} as const;

const yandexCallbackQuery = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

type MetaSource = { ip: string; headers: Record<string, unknown> };
const extractMeta = (request: MetaSource): { ip: string | null; userAgent: string | null } => {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
};

export const yandexAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const isProd = app.config.NODE_ENV === 'production';
  const sessionCookieOpts = sessionCookieOptions(app.config);
  const stateOpts = stateCookieOptions(isProd);
  const clearStateOpts = clearStateCookieOptions(isProd);

  // Хелпер: редирект на FRONTEND_OAUTH_ERROR_URL с кодом ошибки в query.
  // Если ошибочный URL не сконфигурирован — 400 JSON (случай теста без env).
  const errorRedirectUrl = (reason: string): string | null => {
    const base = app.config.FRONTEND_OAUTH_ERROR_URL;
    if (!base) return null;
    const url = new URL(base);
    url.searchParams.set('error', reason);
    return url.toString();
  };

  const successRedirectUrl = (): string | null => {
    const base = app.config.FRONTEND_OAUTH_SUCCESS_URL;
    return base ?? null;
  };

  // ── GET /auth/yandex/start ──
  // Генерит state, ставит в подписанную HttpOnly cookie, редиректит на Яндекс.
  // Если Yandex OAuth не настроен → 503.
  app.get('/yandex/start', async (_request, reply) => {
    const client = app.yandexOAuth;
    if (!client) {
      void reply.status(503).send({
        error: {
          code: OAUTH_ERROR_CODES.notConfigured,
          message: 'Яндекс OAuth не настроен на этом сервере',
        },
      });
      return;
    }

    const state = randomBytes(OAUTH_STATE_BYTES).toString('hex');
    const authorizeUrl = client.buildAuthorizeUrl(state);

    void reply.setCookie(OAUTH_STATE_COOKIE, state, stateOpts).redirect(authorizeUrl, 302);
  });

  // ── GET /auth/yandex/callback ──
  // Валидирует state, обменивает code, читает userinfo, upsert-ит user + session,
  // редиректит на фронт. Ошибки → redirect на FRONTEND_OAUTH_ERROR_URL?error=...
  app.get(
    '/yandex/callback',
    {
      schema: {
        querystring: yandexCallbackQuery,
      },
    },
    async (request, reply) => {
      const client = app.yandexOAuth;
      if (!client) {
        void reply.status(503).send({
          error: {
            code: OAUTH_ERROR_CODES.notConfigured,
            message: 'Яндекс OAuth не настроен на этом сервере',
          },
        });
        return;
      }

      // На любой ошибке ниже мы делаем redirect на FRONTEND_OAUTH_ERROR_URL,
      // а не JSON — потому что пользователь пришёл через navigation redirect
      // из Яндекса и его браузер ждёт HTML/redirect, не JSON.
      const failWith = (reason: string, logMeta?: Record<string, unknown>): void => {
        request.log.warn({ reason, ...logMeta }, 'OAuth Яндекс: ошибка callback');
        const url = errorRedirectUrl(reason);
        void reply.clearCookie(OAUTH_STATE_COOKIE, clearStateOpts);
        if (!url) {
          void reply.status(400).send({
            error: { code: reason, message: 'Ошибка OAuth-флоу' },
          });
          return;
        }
        void reply.redirect(url, 302);
      };

      // 1. Яндекс явно вернул отказ пользователя.
      if (request.query.error) {
        failWith(OAUTH_ERROR_CODES.yandexDenied, { yandexError: request.query.error });
        return;
      }

      // 2. Обязательные параметры от Яндекса.
      const { code, state } = request.query;
      if (!code || !state) {
        failWith(OAUTH_ERROR_CODES.stateMismatch, { reason: 'code_or_state_missing' });
        return;
      }

      // 3. State должен совпасть с тем, что мы клали в cookie на /start.
      const rawStateCookie = request.cookies[OAUTH_STATE_COOKIE];
      if (!rawStateCookie) {
        failWith(OAUTH_ERROR_CODES.stateMismatch, { reason: 'state_cookie_missing' });
        return;
      }
      const unsigned = request.unsignCookie(rawStateCookie);
      if (!unsigned.valid || !unsigned.value || unsigned.value !== state) {
        failWith(OAUTH_ERROR_CODES.stateMismatch, { reason: 'state_cookie_mismatch' });
        return;
      }

      // 4. Обмен code на access_token у Яндекса + запрос userinfo.
      try {
        const { accessToken } = await client.exchangeCode(code);
        const info = await client.fetchUserInfo(accessToken);

        const result = await upsertYandexIdentityAndCreateSession(app.db, {
          info,
          sessionTtlDays: app.config.SESSION_TTL_DAYS,
          meta: extractMeta(request),
        });

        request.log.info(
          { origin: result.origin, userId: result.userId },
          'OAuth Яндекс: логин успешен',
        );

        const success = successRedirectUrl();
        void reply.clearCookie(OAUTH_STATE_COOKIE, clearStateOpts);
        void reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOpts);
        if (!success) {
          // Фолбэк: если success URL не сконфигурирован — отдаём 200 JSON.
          // На проде это не должно случиться (config его валидирует).
          void reply.status(200).send({ ok: true });
          return;
        }
        void reply.redirect(success, 302);
        return;
      } catch (err) {
        if (err instanceof YandexNoEmailError) {
          failWith(OAUTH_ERROR_CODES.noEmail, {});
          return;
        }
        if (err instanceof YandexOAuthError) {
          failWith(OAUTH_ERROR_CODES.yandexApi, { err: err.message });
          return;
        }
        request.log.error({ err }, 'OAuth Яндекс: необработанная ошибка callback');
        failWith(OAUTH_ERROR_CODES.serverError, {});
        return;
      }
    },
  );
};
