import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { SESSION_COOKIE_NAME } from '../../src/lib/session-cookie.js';
import {
  type YandexOAuthClient,
  type YandexUserInfo,
} from '../../src/modules/auth/yandex-client.js';
import { companies, identities, memberships, users } from '../../src/db/schema/index.js';

const STATE_COOKIE_NAME = 'smt_oauth_state';

// Стаб Yandex-клиента. Каждый тест ставит currentUser в setUser() и
// buildStub().exchangeCode/fetchUserInfo возвращают его.
type ControllableStub = YandexOAuthClient & {
  setUser: (info: YandexUserInfo) => void;
  reset: () => void;
};

const buildStub = (): ControllableStub => {
  let current: YandexUserInfo | null = null;
  return {
    buildAuthorizeUrl: (state: string) =>
      `https://oauth.yandex.ru/authorize?client_id=test&state=${state}`,
    exchangeCode: async (_code: string) => ({ accessToken: 'stub-access-token' }),
    fetchUserInfo: async (_token: string) => {
      if (!current) throw new Error('stub: setUser не вызван');
      return current;
    },
    setUser: (info) => {
      current = info;
    },
    reset: () => {
      current = null;
    },
  };
};

// Читает cookie <name>=... из массива Set-Cookie. Отдаёт полное raw-value
// (включая подпись, если cookie signed). Нужно чтобы прокинуть подписанную
// state-cookie обратно в /callback.
const extractCookieRaw = (
  setCookieHeader: string | string[] | undefined,
  name: string,
): string | null => {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (key === name) return decodeURIComponent(value);
  }
  return null;
};

// Выполнить /yandex/start и вернуть state (для callback query) + сырое value
// state-cookie (для передачи в cookies при callback).
const runStartAndGetState = async (
  app: FastifyInstance,
): Promise<{
  state: string;
  stateCookieValue: string;
  res: Awaited<ReturnType<typeof app.inject>>;
}> => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/yandex/start' });
  const stateCookieValue = extractCookieRaw(res.headers['set-cookie'], STATE_COOKIE_NAME);
  if (!stateCookieValue) throw new Error('/yandex/start не поставил state cookie');
  // State в query authorizeUrl.
  const location = res.headers['location'];
  if (typeof location !== 'string') throw new Error('/yandex/start не редиректнул');
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error('в редиректе нет state');
  return { state, stateCookieValue, res };
};

describe('Yandex OAuth', () => {
  let app: FastifyInstance;
  let stub: ControllableStub;

  beforeAll(async () => {
    stub = buildStub();
    app = await buildTestApp({ yandexOAuth: stub });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll();
    stub.reset();
  });

  it('GET /yandex/start → 302 на oauth.yandex.ru + подписанная state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/yandex/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/^https:\/\/oauth\.yandex\.ru\/authorize\?/);
    const stateCookie = extractCookieRaw(res.headers['set-cookie'], STATE_COOKIE_NAME);
    expect(stateCookie).toBeTruthy();
    // Подписанная cookie: value содержит "." (плейн + подпись).
    expect(stateCookie).toContain('.');
  });

  it('callback (новый юзер): создаёт users + companies + memberships + identities + сессию', async () => {
    stub.setUser({
      id: 'yandex-uid-1',
      default_email: 'newuser@ya.ru',
      display_name: 'Пётр Петров',
      real_name: 'Пётр Петров',
      login: 'petya',
    });

    const { state, stateCookieValue } = await runStartAndGetState(app);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex/callback?code=stub-code&state=${state}`,
      cookies: { [STATE_COOKIE_NAME]: stateCookieValue },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers['location']).toBe('http://localhost:5173/');
    // Session-cookie поставилась.
    const sessionCookie = extractCookieRaw(callback.headers['set-cookie'], SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeTruthy();

    // В БД появились строки.
    const { db } = getSetupDb();
    const [u] = await db.select().from(users).where(eq(users.email, 'newuser@ya.ru')).limit(1);
    expect(u).toBeDefined();
    expect(u?.passwordHash).toBeNull();
    expect(u?.name).toBe('Пётр Петров');

    const [c] = await db.select().from(companies).limit(1);
    expect(c?.name).toBe('Компания Пётр Петров');

    const [m] = await db.select().from(memberships).limit(1);
    expect(m?.role).toBe('owner');
    expect(m?.status).toBe('active');

    const [ident] = await db.select().from(identities).limit(1);
    expect(ident?.provider).toBe('yandex');
    expect(ident?.providerUserId).toBe('yandex-uid-1');
    expect(ident?.emailAtLink).toBe('newuser@ya.ru');
  });

  it('callback (email-link): существующий email+password юзер → linked identity, не создаётся новая компания', async () => {
    // Сначала регистрируем юзера через email+password.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'existing@ya.ru',
        password: 'password1234',
        companyName: 'Моя старая компания',
        userName: 'Существующий Юзер',
      },
    });
    const { db } = getSetupDb();
    const companiesBefore = await db.select().from(companies);
    const usersBefore = await db.select().from(users);
    expect(companiesBefore).toHaveLength(1);
    expect(usersBefore).toHaveLength(1);

    // Логинимся через Яндекс с тем же email.
    stub.setUser({
      id: 'yandex-uid-2',
      default_email: 'existing@ya.ru',
      display_name: 'Другое отображение',
    });
    const { state, stateCookieValue } = await runStartAndGetState(app);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex/callback?code=stub-code&state=${state}`,
      cookies: { [STATE_COOKIE_NAME]: stateCookieValue },
    });
    expect(callback.statusCode).toBe(302);

    // Не создалась новая компания и не создался новый юзер.
    const companiesAfter = await db.select().from(companies);
    const usersAfter = await db.select().from(users);
    expect(companiesAfter).toHaveLength(1);
    expect(usersAfter).toHaveLength(1);

    // Идентити прилинковалось к существующему юзеру.
    const [ident] = await db.select().from(identities).limit(1);
    expect(ident?.userId).toBe(usersBefore[0]?.id);
    expect(ident?.providerUserId).toBe('yandex-uid-2');
    // Имя юзера НЕ перезаписалось — стабильность приоритет.
    const [uAfter] = await db.select().from(users).limit(1);
    expect(uAfter?.name).toBe('Существующий Юзер');
  });

  it('callback (identity-hit): повторный логин тем же yandex_id → тот же юзер, новая сессия', async () => {
    // Первый логин.
    stub.setUser({ id: 'yandex-uid-3', default_email: 'repeat@ya.ru', display_name: 'Repeater' });
    const first = await runStartAndGetState(app);
    await app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex/callback?code=c1&state=${first.state}`,
      cookies: { [STATE_COOKIE_NAME]: first.stateCookieValue },
    });

    const { db } = getSetupDb();
    const usersAfterFirst = await db.select().from(users);
    const identitiesAfterFirst = await db.select().from(identities);
    expect(usersAfterFirst).toHaveLength(1);
    expect(identitiesAfterFirst).toHaveLength(1);

    // Второй логин через тот же yandex_id — email может даже измениться,
    // но identity-hit найдёт по (provider, provider_user_id) и не будет менять email.
    stub.setUser({ id: 'yandex-uid-3', default_email: 'other@ya.ru', display_name: 'Repeater' });
    const second = await runStartAndGetState(app);
    const callback2 = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/yandex/callback?code=c2&state=${second.state}`,
      cookies: { [STATE_COOKIE_NAME]: second.stateCookieValue },
    });
    expect(callback2.statusCode).toBe(302);

    // Всё ещё один юзер и одна identity.
    const usersAfterSecond = await db.select().from(users);
    const identitiesAfterSecond = await db.select().from(identities);
    expect(usersAfterSecond).toHaveLength(1);
    expect(identitiesAfterSecond).toHaveLength(1);
    // Email в users остался прежним.
    expect(usersAfterSecond[0]?.email).toBe('repeat@ya.ru');
  });

  it('callback без state cookie → редирект на error URL с ?error=state_mismatch', async () => {
    stub.setUser({ id: 'yandex-uid-x', default_email: 'x@ya.ru' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/yandex/callback?code=c&state=some-state',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:5173/auth/error?error=state_mismatch');
  });

  it('callback: state в query не совпал с cookie → редирект state_mismatch', async () => {
    const { stateCookieValue } = await runStartAndGetState(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/yandex/callback?code=c&state=WRONG-STATE',
      cookies: { [STATE_COOKIE_NAME]: stateCookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:5173/auth/error?error=state_mismatch');
  });

  it('Яндекс отдал error в query → редирект с ?error=yandex_denied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/yandex/callback?error=access_denied&state=abc',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:5173/auth/error?error=yandex_denied');
  });

  it('Yandex OAuth не настроен → /start отвечает 503', async () => {
    const disabledApp = await buildTestApp({ yandexOAuth: null });
    await disabledApp.ready();
    try {
      const res = await disabledApp.inject({ method: 'GET', url: '/api/v1/auth/yandex/start' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('yandex_not_configured');
    } finally {
      await disabledApp.close();
    }
  });
});
