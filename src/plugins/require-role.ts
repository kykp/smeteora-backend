import { type onRequestAsyncHookHandler } from 'fastify';
import { hasRoleAtLeast, type Role } from '../db/constants.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

// Фабрика preHandler'ов. Использование в route options:
//   { preHandler: [app.authenticate, requireRole('member')] }
//
// Порядок важен: сначала authenticate заполнит request.ctx, потом requireRole
// проверит роль. Если authenticate не был вызван — 401 (не 403), потому что
// отсутствие ctx означает "неаутентифицированный запрос", а не "недостаточно прав".
export const requireRole = (minRole: Role): onRequestAsyncHookHandler => {
  return async function requireRoleHook(request) {
    const ctx = request.ctx;
    if (!ctx) throw new UnauthorizedError();
    if (!hasRoleAtLeast(ctx.role, minRole)) throw new ForbiddenError();
  };
};
