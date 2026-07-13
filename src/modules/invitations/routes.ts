import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../lib/session-cookie.js';
import * as service from './service.js';
import {
  acceptInvitationBodySchema,
  authUserResponseSchema,
  createInvitationBodySchema,
  createInvitationResponseSchema,
  invitationIdParamSchema,
  listInvitationsQuerySchema,
  listInvitationsResponseSchema,
  previewInvitationBodySchema,
  previewInvitationResponseSchema,
  revokeInvitationResponseSchema,
} from './schema.js';

// Метаданные запроса для аудита в session — те же поля что в auth-модуле.
type MetaSource = { ip: string; headers: Record<string, unknown> };
const extractMeta = (request: MetaSource): { ip: string | null; userAgent: string | null } => {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
};

// Все эндпоинты, кроме preview/accept, проходят цепочку authenticate + requireRole
// + withCompanyContext. Preview и accept — публичные, свою транзакцию открывают
// внутри service через runWithInvitationToken.
export const invitationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const cookieOpts = sessionCookieOptions(app.config);
  const isTest = app.config.NODE_ENV === 'test';
  // Тот же rate-limit что у auth: brute-force accept-токенов защищаем.
  // В test-env выключен — интеграционные тесты за секунды делают десятки попыток.
  const acceptRateLimit = {
    rateLimit: {
      max: isTest ? Number.MAX_SAFE_INTEGER : 10,
      timeWindow: '1 minute',
    },
  } as const;

  const assertCtx = (
    ctx: { companyId: string; userId: string } | undefined,
  ): { companyId: string; userId: string } => {
    if (!ctx) throw new UnauthorizedError();
    return ctx;
  };

  const assertTx = (tx: Db | undefined): Db => {
    if (!tx) throw new UnauthorizedError();
    return tx;
  };

  // Базовый URL фронта для accept-ссылки. Берём первый origin из CORS-whitelist.
  // Если админ добавляет несколько origins (staging + prod) — первый считается основным.
  const frontendUrl = app.config.CORS_ORIGIN[0] ?? 'http://localhost:5173';

  // ── POST /invitations ───────────────────────────────────────────
  app.post(
    '/',
    {
      schema: {
        body: createInvitationBodySchema,
        response: { 201: createInvitationResponseSchema },
        tags: ['invitations'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const result = await service.create(tx, {
        companyId: ctx.companyId,
        invitedByUserId: ctx.userId,
        body: request.body,
        frontendUrl,
      });

      // ВНИМАНИЕ: acceptUrl содержит однократный токен, дающий право
      // присоединиться к компании. В логи он НЕ должен попадать — любой с
      // read-доступом к логам (Loki/journalctl/pino output) до его истечения
      // (7 дней) сможет принять приглашение за приглашённого. Раньше здесь
      // был `acceptUrl: result.acceptUrl` — снесено.
      request.log.info(
        {
          invitationId: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
        },
        'приглашение создано',
      );

      void reply.status(201);
      return result;
    },
  );

  // ── GET /invitations ────────────────────────────────────────────
  app.get(
    '/',
    {
      schema: {
        querystring: listInvitationsQuerySchema,
        response: { 200: listInvitationsResponseSchema },
        tags: ['invitations'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.list(tx, ctx, request.query);
    },
  );

  // ── POST /invitations/:id/revoke ────────────────────────────────
  app.post(
    '/:id/revoke',
    {
      schema: {
        params: invitationIdParamSchema,
        response: { 200: revokeInvitationResponseSchema },
        tags: ['invitations'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await service.revoke(tx, ctx, request.params.id);
      return { ok: true as const };
    },
  );

  // ── POST /invitations/preview ───────────────────────────────────
  // Публичный: показывает мета-данные приглашения по плоскому токену.
  // Auth-плагин и withCompanyContext НЕ подключены — доступ по токену.
  app.post(
    '/preview',
    {
      schema: {
        body: previewInvitationBodySchema,
        response: { 200: previewInvitationResponseSchema },
        tags: ['invitations'],
      },
      config: acceptRateLimit,
    },
    async (request) => {
      return service.preview(app.db, request.body.token);
    },
  );

  // ── POST /invitations/accept ────────────────────────────────────
  // Публичный: принимает приглашение. Создаёт membership + session, ставит cookie.
  app.post(
    '/accept',
    {
      schema: {
        body: acceptInvitationBodySchema,
        response: { 200: authUserResponseSchema },
        tags: ['invitations'],
      },
      config: acceptRateLimit,
    },
    async (request, reply) => {
      const { sessionId, response } = await service.accept(app.db, {
        body: request.body,
        sessionTtlDays: app.config.SESSION_TTL_DAYS,
        meta: extractMeta(request),
      });
      void reply.setCookie(SESSION_COOKIE_NAME, sessionId, cookieOpts);
      return response;
    },
  );
};
