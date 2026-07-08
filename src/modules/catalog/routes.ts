import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import * as service from './service.js';
import {
  clearProductsBodySchema,
  clearProductsResponseSchema,
  createCategoryBodySchema,
  createProductBodySchema,
  idParamSchema,
  listBrandsQuerySchema,
  listBrandsResponseSchema,
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

  // ── GET /products/brands ──
  // Стабильный список всех брендов в scope, с counts. Порядок count DESC / brand ASC.
  // Отдельный endpoint потому что список товаров возвращает страницу, а фильтру
  // нужен полный словарь. Иначе бренды прыгают при смене страницы.
  app.get(
    '/brands',
    {
      schema: {
        querystring: listBrandsQuerySchema,
        response: { 200: listBrandsResponseSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.listBrands(tx, ctx, request.query);
    },
  );

  // ── POST /products/clear ──
  // Массовый soft-delete всех своих товаров. Роль admin+, тело { confirm }
  // с именем компании. Регистрируется ДО /:id, чтобы Fastify не считал
  // «clear» за UUID.
  app.post(
    '/clear',
    {
      schema: {
        body: clearProductsBodySchema,
        response: { 200: clearProductsResponseSchema },
        tags: ['catalog'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.clearOwnProducts(tx, ctx, request.body);
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
