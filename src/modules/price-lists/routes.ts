import { z } from 'zod';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import { type AuthContext } from '../../plugins/auth.js';
import * as service from './service.js';
import {
  commitPriceListBodySchema,
  commitPriceListResponseSchema,
  listPriceListsResponseSchema,
  parsePriceListResponseSchema,
} from './schema.js';

const assertCtx = (ctx: AuthContext | undefined): AuthContext => {
  if (!ctx) throw new UnauthorizedError();
  return ctx;
};
const assertTx = (tx: Db | undefined): Db => {
  if (!tx) throw new UnauthorizedError();
  return tx;
};

const idParamSchema = z.object({ id: z.string().uuid() });

export const priceListsRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── POST /parse ──
  // multipart/form-data с одним файлом. Схема запроса не описана zod'ом —
  // fastify-multipart вычитывает поток отдельно (стандарт для мультипарта).
  // Ответ строго типизирован.
  app.post(
    '/parse',
    {
      schema: {
        response: { 200: parsePriceListResponseSchema },
        tags: ['price-lists'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const file = await request.file();
      if (!file) throw new ValidationError('Файл не передан (поле "file")');

      const buffer = await file.toBuffer();
      const truncated = file.file.truncated;

      return service.parsePriceList(tx, app.storage, ctx, {
        buffer,
        filename: file.filename,
        mimeType: file.mimetype || null,
        truncated,
      });
    },
  );

  // ── POST /:id/commit ──
  // Тело — маппинг колонок + defaults. Идёт uspert товаров.
  app.post(
    '/:id/commit',
    {
      schema: {
        params: idParamSchema,
        body: commitPriceListBodySchema,
        response: { 200: commitPriceListResponseSchema },
        tags: ['price-lists'],
      },
      onRequest: [app.authenticate, requireRole('member'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.commitPriceList(tx, app.storage, ctx, request.params.id, request.body);
    },
  );

  // ── GET / ──
  // История загрузок (последние 50).
  app.get(
    '/',
    {
      schema: {
        response: { 200: listPriceListsResponseSchema },
        tags: ['price-lists'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.listPriceLists(tx, ctx);
    },
  );
};
