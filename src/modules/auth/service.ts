import { type Db } from '../../db/client.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { runWithoutCompanyContext } from '../../plugins/with-company-context.js';
import * as repo from './repo.js';
import * as worksService from '../works/service.js';
import { type AuthUserResponse } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type AuthMeta = {
  ip: string | null;
  userAgent: string | null;
};

export type AuthResult = {
  sessionId: string;
  response: AuthUserResponse;
};

// Единый сборщик /me-ответа. Используется register, login, /me, switch-company
// и email-OTP verify.
export const buildAuthResponse = async (
  db: Db,
  params: { userId: string; membershipId: string },
): Promise<AuthUserResponse> => {
  const user = await repo.findUserById(db, params.userId);
  if (!user) throw new UnauthorizedError();

  const allMemberships = await repo.listActiveMembershipsForUser(db, params.userId);
  const active = allMemberships.find((m) => m.membershipId === params.membershipId);
  if (!active) throw new UnauthorizedError();

  return {
    user: { id: user.id, email: user.email, name: user.name },
    company: { name: active.companyName },
    role: active.role,
    activeMembershipId: active.membershipId,
    memberships: allMemberships.map((m) => ({
      id: m.membershipId,
      companyName: m.companyName,
      role: m.role,
      isActive: m.status === 'active',
    })),
  };
};

export const register = async (
  db: Db,
  params: {
    email: string;
    password: string;
    companyName: string;
    userName?: string;
    sessionTtlDays: number;
    meta: AuthMeta;
  },
): Promise<AuthResult> => {
  // Одной транзакцией: user + company + owner-membership + session.
  return runWithoutCompanyContext(db, async (tx) => {
    const existing = await repo.findUserByEmail(tx, params.email);
    if (existing) throw new ConflictError('Пользователь с таким email уже существует');

    const passwordHash = await hashPassword(params.password);
    const user = await repo.insertUser(tx, {
      email: params.email,
      passwordHash,
      name: params.userName ?? null,
    });
    const company = await repo.insertCompany(tx, params.companyName);
    const membership = await repo.insertMembership(tx, {
      userId: user.id,
      companyId: company.id,
      role: 'owner',
    });
    await worksService.seedDefaultWorkItems(tx, company.id);

    const expiresAt = new Date(Date.now() + params.sessionTtlDays * DAY_MS);
    const sessionId = await repo.insertSession(tx, {
      userId: user.id,
      activeMembershipId: membership.id,
      expiresAt,
      ip: params.meta.ip,
      userAgent: params.meta.userAgent,
    });

    const response = await buildAuthResponse(tx, {
      userId: user.id,
      membershipId: membership.id,
    });

    return { sessionId, response };
  });
};

export const login = async (
  db: Db,
  params: {
    email: string;
    password: string;
    sessionTtlDays: number;
    meta: AuthMeta;
  },
): Promise<AuthResult> => {
  return runWithoutCompanyContext(db, async (tx) => {
    const user = await repo.findUserByEmail(tx, params.email);
    if (!user) throw new UnauthorizedError('Неверный email или пароль');

    // OAuth-only юзер (password_hash IS NULL) — паролем зайти не может.
    // Сообщение общее, чтобы не подсказывать «этот email есть, но зайдите через Яндекс».
    if (user.passwordHash === null) throw new UnauthorizedError('Неверный email или пароль');

    const ok = await verifyPassword(user.passwordHash, params.password);
    if (!ok) throw new UnauthorizedError('Неверный email или пароль');

    const activeMemberships = await repo.listActiveMembershipsForUser(tx, user.id);
    const usable = activeMemberships.filter((m) => m.status === 'active');
    if (usable.length === 0) {
      // Есть учётка, но во всех компаниях membership disabled → нельзя войти никуда.
      throw new UnauthorizedError('Учётная запись отключена');
    }

    // Первый доступный по времени создания — простое дефолтное правило.
    // Юзер потом может переключиться через switch-company.
    const active = usable[0];
    if (!active) throw new UnauthorizedError();

    const expiresAt = new Date(Date.now() + params.sessionTtlDays * DAY_MS);
    const sessionId = await repo.insertSession(tx, {
      userId: user.id,
      activeMembershipId: active.membershipId,
      expiresAt,
      ip: params.meta.ip,
      userAgent: params.meta.userAgent,
    });

    const response = await buildAuthResponse(tx, {
      userId: user.id,
      membershipId: active.membershipId,
    });

    return { sessionId, response };
  });
};

export const logout = async (db: Db, sessionId: string): Promise<void> => {
  return runWithoutCompanyContext(db, async (tx) => {
    await repo.revokeSession(tx, sessionId);
  });
};

export const me = async (
  db: Db,
  params: { userId: string; membershipId: string },
): Promise<AuthUserResponse> => {
  return runWithoutCompanyContext(db, (tx) => buildAuthResponse(tx, params));
};

// PATCH /auth/me — обновить свой профиль. Возвращает свежий /me-ответ.
export const updateMe = async (
  db: Db,
  params: {
    userId: string;
    membershipId: string;
    patch: { name?: string | null | undefined };
  },
): Promise<AuthUserResponse> => {
  return runWithoutCompanyContext(db, async (tx) => {
    if (params.patch.name !== undefined) {
      await repo.updateUserName(tx, { userId: params.userId, name: params.patch.name });
    }
    return buildAuthResponse(tx, {
      userId: params.userId,
      membershipId: params.membershipId,
    });
  });
};

// POST /auth/change-password. Требует currentPassword — подтверждаем что
// это реальный владелец, а не украденная сессия. Остальные сессии этого
// юзера отзываются: если пароль сменили, значит скомпрометирован — все
// остальные девайсы отваливаются.
// OAuth-only юзер (password_hash IS NULL) → 400: у него нет пароля, менять
// нечего. Установка первого пароля из OAuth-акка — отдельный флоу, пока не
// реализован.
export const changePassword = async (
  db: Db,
  params: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
  },
): Promise<void> => {
  return runWithoutCompanyContext(db, async (tx) => {
    const user = await repo.findUserById(tx, params.userId);
    if (!user) throw new UnauthorizedError();
    if (user.passwordHash === null) {
      throw new ConflictError('У аккаунта нет пароля. Вход только через OAuth-провайдер.');
    }
    const ok = await verifyPassword(user.passwordHash, params.currentPassword);
    if (!ok) throw new UnauthorizedError('Неверный текущий пароль');

    if (params.newPassword === params.currentPassword) {
      throw new ConflictError('Новый пароль совпадает с текущим');
    }

    const newHash = await hashPassword(params.newPassword);
    await repo.updateUserPasswordHash(tx, { userId: params.userId, passwordHash: newHash });
    // Отзываем все остальные сессии — текущая остаётся.
    await repo.revokeOtherUserSessions(tx, {
      userId: params.userId,
      keepSessionId: params.sessionId,
    });
  });
};

export const switchCompany = async (
  db: Db,
  params: { userId: string; sessionId: string; membershipId: string },
): Promise<AuthUserResponse> => {
  return runWithoutCompanyContext(db, async (tx) => {
    const membership = await repo.findMembershipForUser(tx, {
      userId: params.userId,
      membershipId: params.membershipId,
    });
    if (!membership || membership.status !== 'active') {
      // 404, а не 403 — не подтверждаем существование чужих membership'ов.
      throw new NotFoundError('Membership не найден');
    }

    const company = await repo.findCompanyById(tx, membership.companyId);
    if (!company) throw new NotFoundError('Компания не найдена');

    await repo.updateSessionActiveMembership(tx, {
      sessionId: params.sessionId,
      activeMembershipId: membership.id,
    });

    return buildAuthResponse(tx, {
      userId: params.userId,
      membershipId: membership.id,
    });
  });
};
