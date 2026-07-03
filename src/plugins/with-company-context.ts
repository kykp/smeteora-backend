import { type FastifyRequest, type onRequestAsyncHookHandler } from 'fastify';
import { type Db } from '../db/client.js';
import { setCompanyContext } from '../db/rls.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Транзакция домена: withCompanyContext открывает её, ставит SET LOCAL app.current_company_id,
    // хендлер работает через неё, onSend её коммитит (или rollback при ошибке).
    tx?: Db;
    // Аутентификационный контекст. Заполняется auth-плагином (следующий инкремент).
    ctx?: {
      userId: string;
      membershipId: string;
      companyId: string;
      role: string;
    };
  }
}

// Фабрика preHandler'ов, оборачивающих запрос в транзакцию с контекстом компании.
// Использовать в route options: { preHandler: withCompanyContext(app) }.
//
// Требование: request.ctx уже заполнен (auth-плагин отработал раньше).
// Без ctx — 500, потому что это программерская ошибка (композиция плагинов).
export const withCompanyContext = (): onRequestAsyncHookHandler => {
  return async function withCompanyContextHook(this, request: FastifyRequest) {
    const ctx = request.ctx;
    if (!ctx) {
      request.log.error(
        'withCompanyContext вызван без request.ctx — auth-плагин должен отработать раньше',
      );
      throw new Error('missing_auth_context');
    }

    // Открываем транзакцию, ставим контекст, пробрасываем tx в request.
    // Транзакция должна закрыться в onResponse — обёрнём это ниже,
    // но простейший вариант для MVP: закрывать через reply hook.
    //
    // Промежуточное решение: делаем транзакцию через ручной BEGIN/COMMIT на пуле,
    // потому что drizzle.transaction принимает callback, а нам нужно держать tx
    // на всё время обработки запроса.
    //
    // Реализация — в следующем инкременте вместе с auth. Здесь оставлен интерфейс
    // и заглушка чтобы дизайн был явно виден.

    // TODO(auth-mvp): реализация ручного BEGIN/SET LOCAL/COMMIT-on-response.
    // Для db-foundation достаточно самой обёртки runInCompanyContext ниже, которую
    // используют юнит-тесты и будущие сервисы.
    await Promise.resolve();
  };
};

// Хелпер для использования вне HTTP (тесты, background jobs, скрипты миграции данных):
// открывает транзакцию, ставит контекст компании, выполняет callback, коммитит.
// При ошибке — rollback.
export const runInCompanyContext = async <T>(
  db: Db,
  companyId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> => {
  return db.transaction(async (tx) => {
    await setCompanyContext(tx, companyId);
    return fn(tx);
  });
};

// Хелпер для системных запросов (auth flow, миграция данных) без контекста компании.
// НЕ используется для доменных таблиц — там RLS вернёт 0 строк.
// Применяется для чтения users/companies (глобальные таблицы без RLS).
export const runWithoutCompanyContext = async <T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
): Promise<T> => {
  return db.transaction((tx) => fn(tx));
};
