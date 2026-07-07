import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import * as service from './service.js';
import { companyResponseSchema, patchCompanyBodySchema } from './schema.js';

// Утилиты — совпадают со стилем других модулей.
const assertCtx = (ctx: unknown): { companyId: string } => {
  if (!ctx || typeof ctx !== 'object' || !('companyId' in ctx)) {
    throw new UnauthorizedError();
  }
  return ctx as { companyId: string };
};
const assertTx = (tx: unknown): Db => {
  if (!tx) throw new UnauthorizedError();
  return tx as Db;
};

export const companyRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── GET /api/v1/company ──
  // Возвращает текущую компанию (из активной сессии). Не принимает id.
  // Читать реквизиты разрешено любому члену (viewer и выше).
  app.get(
    '/',
    {
      schema: {
        response: { 200: companyResponseSchema },
        tags: ['company'],
      },
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.get(tx, ctx.companyId);
    },
  );

  // ── PATCH /api/v1/company ──
  // Обновление реквизитов. Требует admin (owner тоже проходит по иерархии ролей).
  // Body — partial: undefined = не трогаем; null = сбрасываем; string = записываем.
  app.patch(
    '/',
    {
      schema: {
        body: patchCompanyBodySchema,
        response: { 200: companyResponseSchema },
        tags: ['company'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      return service.update(tx, ctx.companyId, request.body);
    },
  );
};
