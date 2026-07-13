import { type Db } from '../../db/client.js';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { generateInvitationToken, hashInvitationToken } from '../../lib/token.js';
import {
  runWithInvitationToken,
  runWithoutCompanyContext,
} from '../../plugins/with-company-context.js';
import * as authRepo from '../auth/repo.js';
import { type AuthUserResponse } from '../auth/schema.js';
import { type Invitation, type Membership } from '../../db/schema/index.js';
import * as repo from './repo.js';
import {
  type AcceptInvitationBody,
  type CreateInvitationBody,
  type CreateInvitationResponse,
  type InvitableRole,
  type InvitationDto,
  type ListInvitationsQuery,
  type ListInvitationsResponse,
  type PreviewInvitationResponse,
} from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITATION_TTL_DAYS = 7;

// Мета для аудита в session — те же поля что в auth-модуле.
export type AuthMeta = {
  ip: string | null;
  userAgent: string | null;
};

const toDto = (row: Invitation): InvitationDto => ({
  id: row.id,
  email: row.email,
  role: row.role as InvitableRole,
  status: row.status,
  invitedByUserId: row.invitedByUserId,
  expiresAt: row.expiresAt.toISOString(),
  acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
});

// Единый сборщик /me-стиль ответа. Дублирует логику auth.buildAuthResponse
// намеренно — переиспользовать через кросс-модульный импорт сервиса можно, но
// это лишний межмодульный вызов. В момент когда shape ответа поменяется —
// поменяется в двух местах.
const buildAuthResponse = async (
  db: Db,
  params: { userId: string; membershipId: string },
): Promise<AuthUserResponse> => {
  const user = await authRepo.findUserById(db, params.userId);
  if (!user) throw new UnauthorizedError();
  const allMemberships = await authRepo.listActiveMembershipsForUser(db, params.userId);
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

export type CreateParams = {
  companyId: string;
  invitedByUserId: string;
  body: CreateInvitationBody;
  frontendUrl: string;
};

export const create = async (tx: Db, params: CreateParams): Promise<CreateInvitationResponse> => {
  // Дубли: не даём двум активным приглашениям висеть на один email.
  const existingPending = await repo.findPendingByCompanyEmail(tx, {
    companyId: params.companyId,
    email: params.body.email,
  });
  if (existingPending) {
    throw new ConflictError('Приглашение для этого email уже активно');
  }

  // Если юзер с таким email уже активный член компании — приглашение бессмысленно.
  const existingUser = await authRepo.findUserByEmail(tx, params.body.email);
  if (existingUser) {
    const activeMembership = await repo.findActiveMembershipInCompany(tx, {
      userId: existingUser.id,
      companyId: params.companyId,
    });
    if (activeMembership) {
      throw new ConflictError('Пользователь уже состоит в компании');
    }
  }

  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);

  const invitation = await repo.insert(tx, {
    companyId: params.companyId,
    invitedByUserId: params.invitedByUserId,
    email: params.body.email,
    role: params.body.role,
    tokenHash,
    expiresAt,
  });

  const acceptUrl = `${params.frontendUrl.replace(/\/$/, '')}/accept-invitation?token=${token}`;

  return {
    invitation: toDto(invitation),
    token,
    acceptUrl,
  };
};

export const list = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListInvitationsQuery,
): Promise<ListInvitationsResponse> => {
  const { items, total } = await repo.listByCompany(tx, {
    companyId: ctx.companyId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  return {
    items: items.map(toDto),
    total,
    limit: query.limit,
    offset: query.offset,
  };
};

export const revoke = async (tx: Db, ctx: { companyId: string }, id: string): Promise<void> => {
  const ok = await repo.revoke(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Приглашение не найдено');
};

// ── Анонимный флоу ──────────────────────────────────────────────

// Общая проверка + чтение invitation по плоскому токену. Возвращает пару
// (invitation, tokenHash) — hash нужен callee чтобы дальше использовать
// его как контекст RLS для UPDATE (accept).
const readActiveByToken = async (
  db: Db,
  token: string,
): Promise<{ invitation: Invitation; tokenHash: string }> => {
  const tokenHash = hashInvitationToken(token);
  const invitation = await runWithInvitationToken(db, tokenHash, (tx) =>
    repo.findPendingByTokenHash(tx, tokenHash),
  );
  if (!invitation) {
    // 400, не 404: цель не подтвердить/опровергнуть существование конкретной
    // строки; для пользователя разница между "нет" и "истёк" не важна,
    // а для attacker'а — молчание.
    throw new ValidationError('Приглашение не найдено или больше не действительно');
  }
  return { invitation, tokenHash };
};

export const preview = async (db: Db, token: string): Promise<PreviewInvitationResponse> => {
  const { invitation } = await readActiveByToken(db, token);
  // Достаём companyName + признак существования юзера. Это уже вне invitations
  // (обычный runWithoutCompanyContext, RLS у companies/users отключён).
  return runWithoutCompanyContext(db, async (tx) => {
    const company = await authRepo.findCompanyById(tx, invitation.companyId);
    if (!company) throw new NotFoundError('Компания приглашения не найдена');
    const user = await authRepo.findUserByEmail(tx, invitation.email);
    return {
      companyName: company.name,
      role: invitation.role as InvitableRole,
      email: invitation.email,
      userExists: user !== undefined,
    };
  });
};

export type AcceptResult = {
  sessionId: string;
  response: AuthUserResponse;
};

export const accept = async (
  db: Db,
  params: {
    body: AcceptInvitationBody;
    sessionTtlDays: number;
    meta: AuthMeta;
  },
): Promise<AcceptResult> => {
  const { invitation, tokenHash } = await readActiveByToken(db, params.body.token);

  // Основной accept-flow — снова открываем tx с token-контекстом (нужно для
  // UPDATE invitations). Все таблицы кроме invitations (users/companies/
  // memberships/sessions) без RLS, работают в этой же транзакции нормально.
  return runWithInvitationToken(db, tokenHash, async (tx) => {
    let membership: Membership;

    const existingUser = await authRepo.findUserByEmail(tx, invitation.email);

    if (existingUser) {
      // Уже есть учётка. password/userName в body игнорируем — они на bootstrap
      // нового юзера, тут не имеют смысла.
      const activeInCompany = await repo.findActiveMembershipInCompany(tx, {
        userId: existingUser.id,
        companyId: invitation.companyId,
      });
      membership = activeInCompany
        ? activeInCompany
        : await authRepo.insertMembership(tx, {
            userId: existingUser.id,
            companyId: invitation.companyId,
            role: invitation.role as InvitableRole,
          });

      const expiresAt = new Date(Date.now() + params.sessionTtlDays * DAY_MS);
      const sessionId = await authRepo.insertSession(tx, {
        userId: existingUser.id,
        activeMembershipId: membership.id,
        expiresAt,
        ip: params.meta.ip,
        userAgent: params.meta.userAgent,
      });
      await repo.markAccepted(tx, invitation.id);

      const response = await buildAuthResponse(tx, {
        userId: existingUser.id,
        membershipId: membership.id,
      });
      return { sessionId, response };
    }

    // Новый юзер: обязательны password + желательно userName.
    if (!params.body.password) {
      throw new ValidationError(
        'Для нового пользователя обязателен password при принятии приглашения',
      );
    }
    const passwordHash = await hashPassword(params.body.password);
    const newUser = await authRepo.insertUser(tx, {
      email: invitation.email,
      passwordHash,
      name: params.body.userName ?? null,
    });
    membership = await authRepo.insertMembership(tx, {
      userId: newUser.id,
      companyId: invitation.companyId,
      role: invitation.role as InvitableRole,
    });
    const expiresAt = new Date(Date.now() + params.sessionTtlDays * DAY_MS);
    const sessionId = await authRepo.insertSession(tx, {
      userId: newUser.id,
      activeMembershipId: membership.id,
      expiresAt,
      ip: params.meta.ip,
      userAgent: params.meta.userAgent,
    });
    await repo.markAccepted(tx, invitation.id);

    const response = await buildAuthResponse(tx, {
      userId: newUser.id,
      membershipId: membership.id,
    });
    return { sessionId, response };
  });
};
