import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import * as service from './service.js';
import {
  createEstimateBodySchema,
  estimateDeleteResponseSchema,
  estimateIdParamSchema,
  estimateTreeResponseSchema,
  listEstimatesQuerySchema,
  listEstimatesResponseSchema,
  upsertTreeBodySchema,
} from './schema.js';

// Все эндпоинты проходят четыре гейта:
//   1) authenticate — заполняет request.ctx
//   2) requireRole  — минимальная роль
//   3) withCompanyContext — открывает доменную tx с SET LOCAL app.current_company_id
export const estimatesRoutes: FastifyPluginAsyncZod = async (app) => {
  const assertCtx = (ctx: AuthContext | undefined): AuthContext => {
    if (!ctx) throw new UnauthorizedError();
    return ctx;
  };
  const assertTx = (tx: Db | undefined): Db => {
    if (!tx) throw new UnauthorizedError();
    return tx;
  };

  // ── GET /estimates ──────────────────────────────────────────────
  app.get(
    '/',
    {
      schema: {
        querystring: listEstimatesQuerySchema,
        response: { 200: listEstimatesResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.list(tx, ctx, request.query);
    },
  );

  // ── GET /estimates/:id ──────────────────────────────────────────
  app.get(
    '/:id',
    {
      schema: {
        params: estimateIdParamSchema,
        response: { 200: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.getTree(tx, ctx, request.params.id);
    },
  );

  // ── POST /estimates ─────────────────────────────────────────────
  // Создаём только шапку. Дерево — через PUT /:id/tree отдельным запросом.
  // Так UX редактора смет: сначала "новая смета" → получил id → потом наполнил.
  app.post(
    '/',
    {
      schema: {
        body: createEstimateBodySchema,
        response: { 201: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const created = await service.create(tx, ctx, request.body);
      void reply.status(201);
      return created;
    },
  );

  // ── PUT /estimates/:id/tree ─────────────────────────────────────
  // Полный tree-upsert: клиент шлёт целое дерево, сервер diff'ит и применяет.
  app.put(
    '/:id/tree',
    {
      schema: {
        params: estimateIdParamSchema,
        body: upsertTreeBodySchema,
        response: { 200: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.upsertTree(tx, ctx, request.params.id, request.body);
    },
  );

  // ── POST /estimates/:id/archive ─────────────────────────────────
  app.post(
    '/:id/archive',
    {
      schema: {
        params: estimateIdParamSchema,
        response: { 200: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.archive(tx, ctx, request.params.id);
    },
  );

  // ── POST /estimates/:id/unarchive ───────────────────────────────
  app.post(
    '/:id/unarchive',
    {
      schema: {
        params: estimateIdParamSchema,
        response: { 200: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.unarchive(tx, ctx, request.params.id);
    },
  );

  // ── DELETE /estimates/:id ───────────────────────────────────────
  app.delete(
    '/:id',
    {
      schema: {
        params: estimateIdParamSchema,
        response: { 200: estimateDeleteResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await service.softDelete(tx, ctx, request.params.id);
      return { ok: true as const };
    },
  );
};
