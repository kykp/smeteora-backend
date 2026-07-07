import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';
import { createRealYandexClient, type YandexOAuthClient } from '../modules/auth/yandex-client.js';

// Декоратор app.yandexOAuth — null если провайдер не настроен в env.
// Реальные роуты /auth/yandex/* сами проверяют null и отвечают 503.
declare module 'fastify' {
  interface FastifyInstance {
    yandexOAuth: YandexOAuthClient | null;
  }
}

// Плагин ставится с уже готовым инстансом (или null). Это нужно чтобы тесты
// могли инжектить свой стаб через buildApp(config, { yandexOAuth: stub }).
const yandexOAuthPlugin: FastifyPluginAsync<{ client: YandexOAuthClient | null }> = async (
  app,
  opts,
) => {
  app.decorate('yandexOAuth', opts.client);
};

export default fp(yandexOAuthPlugin, { name: 'yandex-oauth', dependencies: [] });

// Собирает Yandex-клиент из config-а. Возвращает null если хоть одна из
// обязательных переменных не задана. Валидация «все или ничего» уже сделана
// в config.ts, здесь только проверка присутствия.
export const buildYandexClientFromConfig = (config: {
  YANDEX_OAUTH_CLIENT_ID?: string | undefined;
  YANDEX_OAUTH_CLIENT_SECRET?: string | undefined;
  YANDEX_OAUTH_REDIRECT_URI?: string | undefined;
}): YandexOAuthClient | null => {
  const { YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_CLIENT_SECRET, YANDEX_OAUTH_REDIRECT_URI } = config;
  if (!YANDEX_OAUTH_CLIENT_ID || !YANDEX_OAUTH_CLIENT_SECRET || !YANDEX_OAUTH_REDIRECT_URI) {
    return null;
  }
  return createRealYandexClient({
    clientId: YANDEX_OAUTH_CLIENT_ID,
    clientSecret: YANDEX_OAUTH_CLIENT_SECRET,
    redirectUri: YANDEX_OAUTH_REDIRECT_URI,
  });
};
