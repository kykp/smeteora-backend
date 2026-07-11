import { and, eq } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { identities } from '../../db/schema/index.js';
import { runWithoutCompanyContext } from '../../plugins/with-company-context.js';
import { extractDisplayName, extractEmail, type YandexUserInfo } from './yandex-client.js';
import * as repo from './repo.js';
import * as worksService from '../works/service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Причина, по которой мы пришли к финальному user — для аудита и debug-логов.
export type YandexUpsertOrigin =
  | 'identity-hit' // существующая привязка identity → тот же user, второй логин через Яндекс
  | 'email-link' // email из Яндекса совпал с существующим user → привязали identity
  | 'new-user'; // создали user + компанию + owner-membership + identity

export type YandexUpsertResult = {
  readonly sessionId: string;
  readonly origin: YandexUpsertOrigin;
  readonly userId: string;
  readonly membershipId: string;
};

// Дефолтное имя компании для нового юзера. Название всегда переименуется
// потом в настройках; здесь важно только чтобы было непусто.
const buildDefaultCompanyName = (displayName: string | null): string => {
  if (displayName && displayName.trim()) return `Компания ${displayName.trim()}`;
  return 'Моя компания';
};

// Найти identity по (provider, provider_user_id). Простой SELECT.
const findYandexIdentity = async (
  db: Db,
  providerUserId: string,
): Promise<{ userId: string } | undefined> => {
  const rows = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, 'yandex'), eq(identities.providerUserId, providerUserId)))
    .limit(1);
  return rows[0];
};

const insertYandexIdentity = async (
  db: Db,
  params: {
    userId: string;
    providerUserId: string;
    emailAtLink: string | null;
    meta: Record<string, unknown>;
  },
): Promise<void> => {
  await db.insert(identities).values({
    userId: params.userId,
    provider: 'yandex',
    providerUserId: params.providerUserId,
    emailAtLink: params.emailAtLink,
    meta: params.meta,
  });
};

// Основная точка входа. Всё в одной транзакции: если что-то сломается на
// последнем шаге — session/identity не полу-создастся.
export const upsertYandexIdentityAndCreateSession = async (
  db: Db,
  params: {
    info: YandexUserInfo;
    sessionTtlDays: number;
    meta: { ip: string | null; userAgent: string | null };
  },
): Promise<YandexUpsertResult> => {
  const email = extractEmail(params.info);
  const displayName = extractDisplayName(params.info);
  const providerUserId = params.info.id;
  // meta для аудита — храним что Яндекс отдал.
  const identityMeta: Record<string, unknown> = {
    login: params.info.login ?? null,
    displayName: params.info.display_name ?? null,
    realName: params.info.real_name ?? null,
    firstName: params.info.first_name ?? null,
    lastName: params.info.last_name ?? null,
  };

  return runWithoutCompanyContext(db, async (tx) => {
    let userId: string;
    let origin: YandexUpsertOrigin;

    // Путь 1: identity уже существует → это возврат существующего юзера.
    const existingIdentity = await findYandexIdentity(tx, providerUserId);
    if (existingIdentity) {
      userId = existingIdentity.userId;
      origin = 'identity-hit';
    } else if (email !== null) {
      // Путь 2: identity нет, но по email юзер найден → линкуем identity к нему.
      const userByEmail = await repo.findUserByEmail(tx, email);
      if (userByEmail) {
        userId = userByEmail.id;
        origin = 'email-link';
        await insertYandexIdentity(tx, {
          userId,
          providerUserId,
          emailAtLink: email,
          meta: identityMeta,
        });
      } else {
        // Путь 3: полностью новый юзер.
        userId = await createNewYandexUser(tx, {
          email,
          displayName,
          providerUserId,
          identityMeta,
        });
        origin = 'new-user';
      }
    } else {
      // Яндекс не отдал email — Яндекс OAuth без email-scope. Мы просили email;
      // если его нет, значит юзер снял галку. Регистрация без email невозможна.
      throw new YandexNoEmailError();
    }

    // Выбираем первый активный membership (то же правило, что в обычном login).
    const activeMemberships = await repo.listActiveMembershipsForUser(tx, userId);
    const usable = activeMemberships.filter((m) => m.status === 'active');
    const active = usable[0];
    if (!active) {
      // Не должно случиться: путь 3 создаёт membership, путь 1/2 — только для
      // существующих юзеров с ≥1 компании. Но если все memberships disabled —
      // ровно такое же поведение, как в обычном login.
      throw new YandexNoActiveMembershipError();
    }

    const expiresAt = new Date(Date.now() + params.sessionTtlDays * DAY_MS);
    const sessionId = await repo.insertSession(tx, {
      userId,
      activeMembershipId: active.membershipId,
      expiresAt,
      ip: params.meta.ip,
      userAgent: params.meta.userAgent,
    });

    return { sessionId, origin, userId, membershipId: active.membershipId };
  });
};

const createNewYandexUser = async (
  tx: Db,
  params: {
    email: string;
    displayName: string | null;
    providerUserId: string;
    identityMeta: Record<string, unknown>;
  },
): Promise<string> => {
  const user = await repo.insertUser(tx, {
    email: params.email,
    passwordHash: null, // OAuth-only юзер, паролем не входит.
    name: params.displayName,
  });
  const company = await repo.insertCompany(tx, buildDefaultCompanyName(params.displayName));
  const membership = await repo.insertMembership(tx, {
    userId: user.id,
    companyId: company.id,
    role: 'owner',
  });
  await worksService.seedDefaultWorkItems(tx, company.id);
  await insertYandexIdentity(tx, {
    userId: user.id,
    providerUserId: params.providerUserId,
    emailAtLink: params.email,
    meta: params.identityMeta,
  });
  // Возвращаем userId; membership достаётся вторым запросом в основной функции,
  // чтобы код возврата был одинаков для всех трёх путей.
  void membership;
  return user.id;
};

// Специфичные ошибки — роут переводит их в редирект на FRONTEND_OAUTH_ERROR_URL с ?error=...
export class YandexNoEmailError extends Error {
  constructor() {
    super('Яндекс не вернул email пользователя');
    this.name = 'YandexNoEmailError';
  }
}

export class YandexNoActiveMembershipError extends Error {
  constructor() {
    super('У пользователя нет активной компании');
    this.name = 'YandexNoActiveMembershipError';
  }
}
