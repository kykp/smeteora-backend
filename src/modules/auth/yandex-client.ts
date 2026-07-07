import { z } from 'zod';

// Профиль пользователя из https://login.yandex.ru/info?format=json.
// Читаем только нужные поля, остальное игнорируем (Zod .passthrough не ставим —
// сузили сознательно, чтобы не таскать чужое в meta).
const yandexUserInfoSchema = z.object({
  id: z.string().min(1), // permanent Яндекс-id — стабилен, не меняется даже при смене email.
  default_email: z.string().email().nullable().optional(),
  emails: z.array(z.string().email()).optional(),
  display_name: z.string().nullable().optional(),
  real_name: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  login: z.string().nullable().optional(),
});
export type YandexUserInfo = z.infer<typeof yandexUserInfoSchema>;

const yandexTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

// Абстракция клиента — реальный (fetch) в проде, стаб в тестах.
export interface YandexOAuthClient {
  readonly buildAuthorizeUrl: (state: string) => string;
  readonly exchangeCode: (code: string) => Promise<{ accessToken: string }>;
  readonly fetchUserInfo: (accessToken: string) => Promise<YandexUserInfo>;
}

export class YandexOAuthError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'YandexOAuthError';
  }
}

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const USERINFO_URL = 'https://login.yandex.ru/info?format=json';

const TOKEN_EXCHANGE_TIMEOUT_MS = 8_000;
const USERINFO_TIMEOUT_MS = 5_000;

// Фабрика реального HTTP-клиента. Тесты используют собственную реализацию
// интерфейса YandexOAuthClient, минуя реальные HTTP-запросы к Яндексу.
export const createRealYandexClient = (params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): YandexOAuthClient => {
  const { clientId, clientSecret, redirectUri } = params;

  const buildAuthorizeUrl = (state: string): string => {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    // force_confirm=yes — не пропускать окно согласия, если юзер уже давал
    // согласие. Полезно для дебага; в проде можно убрать.
    // url.searchParams.set('force_confirm', 'yes');
    return url.toString();
  };

  const exchangeCode = async (code: string): Promise<{ accessToken: string }> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new YandexOAuthError(`Яндекс token endpoint вернул HTTP ${res.status}`);
      }
      const raw: unknown = await res.json();
      const parsed = yandexTokenResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new YandexOAuthError('Яндекс вернул неожиданный формат ответа token');
      }
      return { accessToken: parsed.data.access_token };
    } catch (err) {
      if (err instanceof YandexOAuthError) throw err;
      throw new YandexOAuthError('Ошибка обмена code на access_token у Яндекса', err);
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchUserInfo = async (accessToken: string): Promise<YandexUserInfo> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), USERINFO_TIMEOUT_MS);
    try {
      const res = await fetch(USERINFO_URL, {
        method: 'GET',
        headers: {
          Authorization: `OAuth ${accessToken}`,
          Accept: 'application/json',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new YandexOAuthError(`Яндекс userinfo вернул HTTP ${res.status}`);
      }
      const raw: unknown = await res.json();
      const parsed = yandexUserInfoSchema.safeParse(raw);
      if (!parsed.success) {
        throw new YandexOAuthError('Яндекс вернул неожиданный формат userinfo');
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof YandexOAuthError) throw err;
      throw new YandexOAuthError('Ошибка получения профиля пользователя у Яндекса', err);
    } finally {
      clearTimeout(timer);
    }
  };

  return { buildAuthorizeUrl, exchangeCode, fetchUserInfo };
};

// Извлечение email — Яндекс отдаёт default_email или массив emails.
// Возвращает нормализованный (lowercased+trimmed) email или null.
export const extractEmail = (info: YandexUserInfo): string | null => {
  const raw = info.default_email ?? info.emails?.[0] ?? null;
  if (!raw) return null;
  return raw.trim().toLowerCase();
};

// Извлечение отображаемого имени. Приоритет: real_name → display_name →
// first_name+last_name → login. null если ничего нет.
export const extractDisplayName = (info: YandexUserInfo): string | null => {
  if (info.real_name && info.real_name.trim()) return info.real_name.trim();
  if (info.display_name && info.display_name.trim()) return info.display_name.trim();
  const first = info.first_name?.trim();
  const last = info.last_name?.trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  if (info.login && info.login.trim()) return info.login.trim();
  return null;
};
