import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole } from '../../plugins/require-role.js';
import { UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { type Db } from '../../db/client.js';
import * as service from './service.js';
import * as logoService from './logo-service.js';
import {
  companyResponseSchema,
  deleteLogoResponseSchema,
  patchCompanyBodySchema,
  uploadLogoResponseSchema,
  LOGO_MAX_BYTES,
} from './schema.js';

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

  // ── POST /api/v1/company/logo ──
  // Multipart-заливка. Один файл в поле "logo". Ограничения — 2 МБ и MIME
  // (png/jpeg/webp) — валидируются сервисом. Пустой ответ (204? нет — 200 +
  // маленький JSON для совместимости с фронтом, ожидающим JSON).
  app.post(
    '/logo',
    {
      schema: {
        response: { 200: uploadLogoResponseSchema },
        tags: ['company'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);

      const file = await request.file();
      if (!file) throw new ValidationError('Файл не передан (поле "logo")');
      // fastify-multipart стримит файл — читаем в буфер. Внутри проверим ещё
      // размер, потому что limits в multipart-плагине только обрезает поток.
      const data = await file.toBuffer();
      if (file.file.truncated) {
        throw new ValidationError(`Размер файла превышает ${LOGO_MAX_BYTES} байт`);
      }
      await logoService.uploadLogo(tx, app.storage, {
        companyId: ctx.companyId,
        data,
        contentType: file.mimetype,
      });
      return { ok: true as const, hasLogo: true as const };
    },
  );

  // ── GET /api/v1/company/logo ──
  // Отдаёт бинарник + Content-Type. Требует любой уровень доступа (viewer),
  // потому что логотип — часть публично отображаемых реквизитов компании
  // для её же сотрудников.
  app.get(
    '/logo',
    {
      onRequest: [app.authenticate, requireRole('viewer'), app.withCompanyContext],
    },
    async (request, reply) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      const { data, contentType } = await logoService.readLogo(tx, app.storage, ctx.companyId);
      void reply.header('Content-Type', contentType);
      void reply.header('Cache-Control', 'private, no-cache');
      return reply.send(data);
    },
  );

  // ── DELETE /api/v1/company/logo ──
  // Идемпотентно: 200 даже если логотипа не было.
  app.delete(
    '/logo',
    {
      schema: {
        response: { 200: deleteLogoResponseSchema },
        tags: ['company'],
      },
      onRequest: [app.authenticate, requireRole('admin'), app.withCompanyContext],
    },
    async (request) => {
      const ctx = assertCtx(request.ctx);
      const tx = assertTx(request.tx);
      await logoService.deleteLogo(tx, app.storage, ctx.companyId);
      return { ok: true as const, hasLogo: false as const };
    },
  );
};
