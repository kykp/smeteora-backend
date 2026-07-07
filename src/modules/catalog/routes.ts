import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import * as service from './service.js';
import {
  createCategoryBodySchema,
  createProductBodySchema,
  idParamSchema,
  listCategoriesResponseSchema,
  listProductsQuerySchema,
  listProductsResponseSchema,
  listUnitsResponseSchema,
  okResponseSchema,
  productCategorySchema,
  productSchema,
  updateCategoryBodySchema,
  updateProductBodySchema,
} from './schema.js';

const assertCtx = (ctx: AuthContext | undefined): AuthContext => {
  if (!ctx) throw new UnauthorizedError();
  return ctx;
};
const assertTx = (tx: Db | undefined): Db => {
  if (!tx) throw new UnauthorizedError();
  return tx;
};

export const unitsRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /units — просто список, доступен любому с viewer (базовый справочник).
  app.get(
    '/',
    {
      schema: { response: { 200: listUnitsResponseSchema }, tags: ['catalog'] },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const tx = assertTx(request.tx);
      return service.listUnits(tx);
    },
  );
};

export const categoriesRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /categories — свои + платформенные.
  app.get(
    '/',
    {
      schema: { response: { 200: listCategoriesResponseSchema }, tags: ['catalog'] },
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
        body: createCategoryBodySchema,
        response: { 201: productCategorySchema },
        tags: ['catalog'],
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
        params: idParamSchema,
        body: updateCategoryBodySchema,
        response: { 200: productCategorySchema },
        tags: ['catalog'],
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
        params: idParamSchema,
        response: { 200: okResponseSchema },
        tags: ['catalog'],
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

export const productsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      schema: {
        querystring: listProductsQuerySchema,
        response: { 200: listProductsResponseSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.listProducts(tx, ctx, request.query);
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        params: idParamSchema,
        response: { 200: productSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.getProduct(tx, ctx, request.params.id);
    },
  );

  app.post(
    '/',
    {
      schema: {
        body: createProductBodySchema,
        response: { 201: productSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const created = await service.createProduct(tx, ctx, request.body);
      void reply.status(201);
      return created;
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: idParamSchema,
        body: updateProductBodySchema,
        response: { 200: productSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.updateProduct(tx, ctx, request.params.id, request.body);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        params: idParamSchema,
        response: { 200: okResponseSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await service.softDeleteProduct(tx, ctx, request.params.id);
      return { ok: true as const };
    },
  );
};
