import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL_MIGRATOR'];
if (!url) {
  throw new Error(
    'DATABASE_URL_MIGRATOR не задан — миграции запускаются под ролью smeteora_migrator, а не app.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
