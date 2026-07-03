// Раннер миграций. Запускается вручную или из CI.
// Использует роль smeteora_migrator (BYPASSRLS + CREATEDB).
// В рантайме приложения НЕ вызывается.

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env['DATABASE_URL_MIGRATOR'];
if (!url) {
  console.error(
    'DATABASE_URL_MIGRATOR не задан. Миграции должны запускаться под ролью migrator, не app.',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);

try {
  console.warn('Применяю миграции...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.warn('Миграции применены успешно.');
} catch (err) {
  console.error('Ошибка при применении миграций:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
