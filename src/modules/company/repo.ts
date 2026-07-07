import { and, eq, isNull } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { companies, type Company } from '../../db/schema/index.js';

// Единственный источник запросов к companies из company-модуля.
// company_id всегда берётся из ctx.companyId (session-context) — никогда из тела.

export const findById = async (db: Db, companyId: string): Promise<Company | undefined> => {
  const rows = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .limit(1);
  return rows[0];
};

// Partial update. patch — плоский объект с полями, которые нужно обновить.
// Возвращает обновлённую строку или undefined если компанию не нашли (что
// невозможно при живой сессии, но обрабатываем на всякий случай).
export const patch = async (
  db: Db,
  companyId: string,
  values: Partial<Company>,
): Promise<Company | undefined> => {
  const [row] = await db
    .update(companies)
    .set(values)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .returning();
  return row;
};

// Прицельно читаем ключ логотипа + content-type — для GET /logo, чтобы
// не таскать всю строку с полями реквизитов.
export const findLogoMeta = async (
  db: Db,
  companyId: string,
): Promise<{ logoKey: string; logoContentType: string | null } | undefined> => {
  const rows = await db
    .select({ logoKey: companies.logoKey, logoContentType: companies.logoContentType })
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || row.logoKey === null) return undefined;
  return { logoKey: row.logoKey, logoContentType: row.logoContentType };
};
