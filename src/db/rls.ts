import { sql, type SQL } from 'drizzle-orm';
import { type Db } from './client.js';

// Помощник для установки контекста компании внутри транзакции.
// ВАЖНО: SET LOCAL действует только до конца транзакции — вне tx не имеет смысла.
// current_setting(..., true) во всех RLS-политиках вернёт NULL если контекст не установлен,
// что означает: без обёртки withCompanyContext запрос к домену вернёт 0 строк.
export const setCompanyContext = (tx: Db, companyId: string): Promise<unknown> =>
  tx.execute(sql`SELECT set_config('app.current_company_id', ${companyId}, true)`);

// Альтернатива, которую можно использовать в raw SQL-запросах вместо параметризации.
export const currentCompanyIdSql: SQL = sql`current_setting('app.current_company_id', true)::uuid`;
