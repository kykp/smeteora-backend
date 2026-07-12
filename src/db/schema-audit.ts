// Аудит расхождений между Drizzle-схемой и реальной БД.
//
// Ловит два класса проблем:
//   MISSING  — колонка объявлена в schema.ts, но в БД её нет.
//              Это критично: код будет валиться 500 на любом SELECT.
//   EXTRA    — колонка есть в БД, но не в schema.ts.
//              Не критично, но тревожно: скорее всего кто-то накатил ALTER
//              руками. Печатается как warning, exit-код не поднимает.
//
// Причина существования: сегодня прод упал 500 потому, что миграция 0014
// в drizzle.__drizzle_migrations числилась применённой, а физически не
// отработала (client_inn / client_address отсутствовали). Journal-таблица
// разошлась с реальностью — restore из старого дампа, прерванная транзакция,
// или ручной DROP COLUMN — точно не установить. Значит верить journal'у на
// слово нельзя, надо каждый деплой перепроверять фактами.
//
// Запускается:
//   1) в CI сразу после db:migrate — если drift → деплой фейлится.
//   2) локально `pnpm db:audit` — быстрая проверка что миграции в порядке.
//
// Роль: smeteora_migrator (BYPASSRLS) — чтобы читать information_schema.

import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import pg from 'pg';

import * as schema from './schema/index.js';

const url = process.env['DATABASE_URL_MIGRATOR'];
if (!url) {
  console.error(
    'DATABASE_URL_MIGRATOR не задан. Аудит ходит под ролью migrator, чтобы читать information_schema.',
  );
  process.exit(2);
}

// Собираем ожидаемую схему из Drizzle: имя таблицы → множество имён колонок.
const collectExpectedSchema = (): Map<string, Set<string>> => {
  const expected = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value as PgTable);
    expected.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
  return expected;
};

// Читаем реальные колонки из public-схемы. Системные drizzle-таблицы и
// расширения — не наши, отсекаем через whitelist из expected.
const collectActualSchema = async (pool: pg.Pool): Promise<Map<string, Set<string>>> => {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = actual.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    actual.set(row.table_name, set);
  }
  return actual;
};

type DriftIssue =
  | { level: 'error'; table: string; kind: 'table-missing' }
  | { level: 'error'; table: string; kind: 'column-missing'; columns: string[] }
  | { level: 'warn'; table: string; kind: 'column-extra'; columns: string[] };

const diff = (
  expected: Map<string, Set<string>>,
  actual: Map<string, Set<string>>,
): DriftIssue[] => {
  const issues: DriftIssue[] = [];
  for (const [table, expectedCols] of expected) {
    const actualCols = actual.get(table);
    if (!actualCols) {
      issues.push({ level: 'error', table, kind: 'table-missing' });
      continue;
    }
    const missing = [...expectedCols].filter((c) => !actualCols.has(c));
    if (missing.length > 0) {
      issues.push({ level: 'error', table, kind: 'column-missing', columns: missing });
    }
    const extra = [...actualCols].filter((c) => !expectedCols.has(c));
    if (extra.length > 0) {
      issues.push({ level: 'warn', table, kind: 'column-extra', columns: extra });
    }
  }
  return issues;
};

const renderIssue = (i: DriftIssue): string => {
  if (i.kind === 'table-missing') {
    return `[ERROR] таблица «${i.table}» объявлена в Drizzle, но отсутствует в БД`;
  }
  if (i.kind === 'column-missing') {
    return `[ERROR] ${i.table}: отсутствуют колонки в БД: ${i.columns.join(', ')}`;
  }
  return `[WARN]  ${i.table}: лишние колонки в БД (не в Drizzle): ${i.columns.join(', ')}`;
};

const main = async (): Promise<void> => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const expected = collectExpectedSchema();
    const actual = await collectActualSchema(pool);
    const issues = diff(expected, actual);

    if (issues.length === 0) {
      console.warn('Schema OK — расхождений между Drizzle и БД нет.');
      return;
    }

    for (const i of issues) console.warn(renderIssue(i));

    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) {
      console.error(`\nDrift detected: ${errors.length} ошибок. Прод не поднимать.`);
      process.exitCode = 1;
    } else {
      console.warn(`\n${issues.length} предупреждений — не блокирующее, но проверьте.`);
    }
  } finally {
    await pool.end();
  }
};

await main();
