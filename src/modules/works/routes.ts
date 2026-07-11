import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import * as service from './service.js';
import {
  applyDefaultsResponseSchema,
  createWorkCategoryBodySchema,
  createWorkItemBodySchema,
  listWorkCategoriesResponseSchema,
  listWorkItemsQuerySchema,
  listWorkItemsResponseSchema,
  updateWorkCategoryBodySchema,
  updateWorkItemBodySchema,
  workCategorySchema,
  workIdParamSchema,
  workItemSchema,
  workOkResponseSchema,
} from './schema.js';

const assertCtx = (ctx: AuthContext | undefined): AuthContext => {
  if (!ctx) throw new UnauthorizedError();
  return ctx;
};
const assertTx = (tx: Db | undefined): Db => {
  if (!tx) throw new UnauthorizedError();
  return tx;
};

export const workCategoriesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      schema: { response: { 200: listWorkCategoriesResponseSchema }, tags: ['works'] },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.listCategories(tx, ctx);
    },
  );

  app.post(
    '/',
    {
      schema: {
        body: createWorkCategoryBodySchema,
        response: { 201: workCategorySchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const created = await service.createCategory(tx, ctx, request.body);
      void reply.status(201);
      return created;
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: workIdParamSchema,
        body: updateWorkCategoryBodySchema,
        response: { 200: workCategorySchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.updateCategory(tx, ctx, request.params.id, request.body);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        params: workIdParamSchema,
        response: { 200: workOkResponseSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await service.softDeleteCategory(tx, ctx, request.params.id);
      return { ok: true as const };
    },
  );
};

export const workItemsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      schema: {
        querystring: listWorkItemsQuerySchema,
        response: { 200: listWorkItemsResponseSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.listItems(tx, ctx, request.query);
    },
  );

  // POST /work-items/apply-defaults — регистрируется ДО /:id, чтобы Fastify
  // не пытался распарсить 'apply-defaults' как UUID. Идемпотентно добавляет
  // недостающие типовые работы из пресета.
  app.post(
    '/apply-defaults',
    {
      schema: {
        response: { 200: applyDefaultsResponseSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.applyDefaultsForCompany(tx, ctx.companyId);
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        params: workIdParamSchema,
        response: { 200: workItemSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.getItem(tx, ctx, request.params.id);
    },
  );

  app.post(
    '/',
    {
      schema: {
        body: createWorkItemBodySchema,
        response: { 201: workItemSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const created = await service.createItem(tx, ctx, request.body);
      void reply.status(201);
      return created;
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: workIdParamSchema,
        body: updateWorkItemBodySchema,
        response: { 200: workItemSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.updateItem(tx, ctx, request.params.id, request.body);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        params: workIdParamSchema,
        response: { 200: workOkResponseSchema },
        tags: ['works'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await service.softDeleteItem(tx, ctx, request.params.id);
      return { ok: true as const };
    },
  );
};
