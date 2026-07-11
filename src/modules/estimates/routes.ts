import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { parseIfMatch } from '../../lib/optimistic-concurrency.js';
import * as service from './service.js';
import {
  createEstimateBodySchema,
  createLineItemBodySchema,
  createSectionBodySchema,
  estimateDeleteResponseSchema,
  estimateIdParamSchema,
  estimateTreeResponseSchema,
  lineItemIdParamSchema,
  lineItemMutationResponseSchema,
  listEstimatesQuerySchema,
  listEstimatesResponseSchema,
  sectionIdParamSchema,
  sectionMutationResponseSchema,
  updateEstimateBodySchema,
  updateLineItemBodySchema,
  updateSectionBodySchema,
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

  // ── PATCH /estimates/:id ────────────────────────────────────────
  // Частичное обновление шапки (title/notes/…) без пересборки дерева.
  app.patch(
    '/:id',
    {
      schema: {
        params: estimateIdParamSchema,
        body: updateEstimateBodySchema,
        response: { 200: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.updateHeader(tx, ctx, request.params.id, request.body);
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

  // ── POST /estimates/:id/duplicate ───────────────────────────────
  // Полная копия сметы с текущими настройками и составом. Новая смета —
  // всегда draft, version=1. Возвращает свежее дерево копии, чтобы фронт
  // сразу перешёл на её id без второго запроса.
  app.post(
    '/:id/duplicate',
    {
      schema: {
        params: estimateIdParamSchema,
        response: { 201: estimateTreeResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const copy = await service.duplicate(tx, ctx, request.params.id);
      void reply.status(201);
      return copy;
    },
  );

  // ── POST /estimates/:id/line-items ─────────────────────────────
  // Атомарное добавление одной строки. Заголовки:
  //   If-Match:         текущая version сметы (для optimistic concurrency)
  //   Idempotency-Key:  uuid, защита от двойных кликов и сетевых ретраев
  app.post(
    '/:id/line-items',
    {
      schema: {
        params: estimateIdParamSchema,
        body: createLineItemBodySchema,
        response: { 200: lineItemMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'POST',
        `/estimates/${request.params.id}/line-items`,
        idempotencyKey,
        () => service.createLineItem(tx, ctx, request.params.id, expectedVersion, request.body),
      );
    },
  );

  // ── PATCH /estimates/:id/line-items/:lineId ────────────────────
  app.patch(
    '/:id/line-items/:lineId',
    {
      schema: {
        params: lineItemIdParamSchema,
        body: updateLineItemBodySchema,
        response: { 200: lineItemMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'PATCH',
        `/estimates/${request.params.id}/line-items/${request.params.lineId}`,
        idempotencyKey,
        () =>
          service.updateLineItem(
            tx,
            ctx,
            request.params.id,
            request.params.lineId,
            expectedVersion,
            request.body,
          ),
      );
    },
  );

  // ── POST /estimates/:id/sections ───────────────────────────────
  app.post(
    '/:id/sections',
    {
      schema: {
        params: estimateIdParamSchema,
        body: createSectionBodySchema,
        response: { 200: sectionMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'POST',
        `/estimates/${request.params.id}/sections`,
        idempotencyKey,
        () => service.createSection(tx, ctx, request.params.id, expectedVersion, request.body),
      );
    },
  );

  // ── PATCH /estimates/:id/sections/:sectionId ───────────────────
  app.patch(
    '/:id/sections/:sectionId',
    {
      schema: {
        params: sectionIdParamSchema,
        body: updateSectionBodySchema,
        response: { 200: sectionMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'PATCH',
        `/estimates/${request.params.id}/sections/${request.params.sectionId}`,
        idempotencyKey,
        () =>
          service.updateSection(
            tx,
            ctx,
            request.params.id,
            request.params.sectionId,
            expectedVersion,
            request.body,
          ),
      );
    },
  );

  // ── DELETE /estimates/:id/sections/:sectionId ──────────────────
  app.delete(
    '/:id/sections/:sectionId',
    {
      schema: {
        params: sectionIdParamSchema,
        response: { 200: sectionMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'DELETE',
        `/estimates/${request.params.id}/sections/${request.params.sectionId}`,
        idempotencyKey,
        () =>
          service.deleteSection(
            tx,
            ctx,
            request.params.id,
            request.params.sectionId,
            expectedVersion,
          ),
      );
    },
  );

  // ── DELETE /estimates/:id/line-items/:lineId ───────────────────
  app.delete(
    '/:id/line-items/:lineId',
    {
      schema: {
        params: lineItemIdParamSchema,
        response: { 200: lineItemMutationResponseSchema },
        tags: ['estimates'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const expectedVersion = parseIfMatch(request.headers['if-match'] as string | undefined);
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      return withIdempotency(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId },
        'DELETE',
        `/estimates/${request.params.id}/line-items/${request.params.lineId}`,
        idempotencyKey,
        () =>
          service.deleteLineItem(
            tx,
            ctx,
            request.params.id,
            request.params.lineId,
            expectedVersion,
          ),
      );
    },
  );
};
