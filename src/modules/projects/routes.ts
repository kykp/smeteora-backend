import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import * as service from './service.js';
import {
  createProjectBodySchema,
  listProjectsQuerySchema,
  listProjectsResponseSchema,
  projectDeleteResponseSchema,
  projectIdParamSchema,
  projectResponseSchema,
  updateProjectBodySchema,
} from './schema.js';

// Все эндпоинты проходят четыре гейта:
//   1) authenticate    — валидная session и membership (заполняет request.ctx)
//   2) requireRole(x)  — минимальная роль
//   3) withCompanyContext — открывает доменную транзакцию с SET LOCAL app.current_company_id
//                          (кладёт транзакцию в request.tx)
// Внутри хендлеров работаем ТОЛЬКО через request.tx, никаких походов в app.db.
export const projectsRoutes: FastifyPluginAsyncZod = async (app) => {
  const assertCtx = (ctx: { companyId: string } | undefined): { companyId: string } => {
    if (!ctx) throw new UnauthorizedError();
    return ctx;
  };

  const assertTx = (tx: Db | undefined): Db => {
    if (!tx) throw new UnauthorizedError();
    return tx;
  };

  // ── GET /projects ───────────────────────────────────────────────
  app.get(
    '/',
    {
      schema: {
        querystring: listProjectsQuerySchema,
        response: { 200: listProjectsResponseSchema },
        tags: ['projects'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.list(tx, ctx, request.query);
    },
  );

  // ── GET /projects/:id ───────────────────────────────────────────
  app.get(
    '/:id',
    {
      schema: {
        params: projectIdParamSchema,
        response: { 200: projectResponseSchema },
        tags: ['projects'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.getById(tx, ctx, request.params.id);
    },
  );

  // ── POST /projects ──────────────────────────────────────────────
  app.post(
    '/',
    {
      schema: {
        body: createProjectBodySchema,
        response: { 201: projectResponseSchema },
        tags: ['projects'],
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

  // ── PATCH /projects/:id ─────────────────────────────────────────
  app.patch(
    '/:id',
    {
      schema: {
        params: projectIdParamSchema,
        body: updateProjectBodySchema,
        response: { 200: projectResponseSchema },
        tags: ['projects'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.update(tx, ctx, request.params.id, request.body);
    },
  );

  // ── DELETE /projects/:id ────────────────────────────────────────
  app.delete(
    '/:id',
    {
      schema: {
        params: projectIdParamSchema,
        response: { 200: projectDeleteResponseSchema },
        tags: ['projects'],
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
