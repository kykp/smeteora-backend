import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getSetupDb } from '../setup/test-db.js';
import { memberships, users, type Membership } from '../../src/db/schema/index.js';
import { type Role } from '../../src/db/constants.js';

// Регистрирует юзера через /api/v1/auth/register, возвращает cookie для
// последующих запросов + метаданные (userId, companyId, membershipId, cookie).
export const registerOwner = async (
  app: FastifyInstance,
  params: { email: string; companyName: string; password?: string },
): Promise<{
  cookie: string;
  userId: string;
  companyId: string;
  membershipId: string;
}> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: params.email,
      password: params.password ?? 'password1234',
      companyName: params.companyName,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register вернул ${res.statusCode}: ${res.body}`);
  }
  const c = res.cookies[0];
  if (!c?.value) throw new Error('register не вернул cookie');
  const cookie = `${c.name}=${c.value}`;

  const { db } = getSetupDb();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, params.email));
  if (!user) throw new Error('registered user не найден в БД');

  const [m] = await db
    .select({ id: memberships.id, companyId: memberships.companyId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership не найдено');

  return { cookie, userId: user.id, companyId: m.companyId, membershipId: m.id };
};

// Добавляет юзеру membership в чужой компании с заданной ролью.
// Используется в тестах role-gate: юзер регистрирует свою компанию (owner),
// потом через этот хелпер получает membership с более низкой ролью в другой.
// Возвращает membershipId.
export const addMembership = async (params: {
  userId: string;
  companyId: string;
  role: Role;
}): Promise<Membership> => {
  const { db } = getSetupDb();
  const [row] = await db
    .insert(memberships)
    .values({ userId: params.userId, companyId: params.companyId, role: params.role })
    .returning();
  if (!row) throw new Error('addMembership: insert вернул пусто');
  return row;
};

// Переключает активную компанию сессии на указанный membershipId.
// Возвращает ту же cookie — Fastify не выдаёт новую при switch, session_id тот же.
export const switchTo = async (
  app: FastifyInstance,
  params: { cookie: string; membershipId: string },
): Promise<void> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/switch-company',
    headers: { cookie: params.cookie },
    payload: { membershipId: params.membershipId },
  });
  if (res.statusCode !== 200) {
    throw new Error(`switch-company вернул ${res.statusCode}: ${res.body}`);
  }
};

// Создаёт проект через API. Возвращает id + отдельный DTO.
export const createProjectViaApi = async (
  app: FastifyInstance,
  params: {
    cookie: string;
    name: string;
    status?: 'draft' | 'in-progress' | 'review' | 'sent' | 'won' | 'lost';
  },
): Promise<{ id: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: params.cookie },
    payload: {
      name: params.name,
      ...(params.status ? { status: params.status } : {}),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create project вернул ${res.statusCode}: ${res.body}`);
  }
  return { id: res.json().id };
};
