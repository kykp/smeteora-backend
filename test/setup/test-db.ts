// Хелперы интеграционных тестов.
//
// Два независимых пула к тестовой БД:
//   1) getTestDb() — под ролью smeteora_app (БЕЗ BYPASSRLS). Ровно тот же путь, что и рантайм.
//      Через него тестируем поведение RLS-политик — как их видит приложение.
//   2) getSetupDb() — под ролью smeteora_migrator (BYPASSRLS + права TRUNCATE).
//      Используется в fixtures и truncateAll: подготовка/очистка не должна ходить через RLS,
//      иначе setup станет частью того что тестируется.
//
// Тестовая БД поднимается docker-compose (порт 5433).

import { createDbClient, type DbClient } from '../../src/db/client.js';

const APP_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://smeteora_app:app_test_password@localhost:5433/smeteora_test';

const SETUP_URL =
  process.env['DATABASE_URL_TEST_MIGRATOR'] ??
  'postgresql://smeteora_migrator:migrator_test_password@localhost:5433/smeteora_test';

let appClient: DbClient | null = null;
let setupClient: DbClient | null = null;

export const getTestDb = (): DbClient => {
  if (!appClient) appClient = createDbClient(APP_URL);
  return appClient;
};

export const getSetupDb = (): DbClient => {
  if (!setupClient) setupClient = createDbClient(SETUP_URL);
  return setupClient;
};

export const closeTestDb = async (): Promise<void> => {
  const pending: Promise<void>[] = [];
  if (appClient) {
    pending.push(appClient.end());
    appClient = null;
  }
  if (setupClient) {
    pending.push(setupClient.end());
    setupClient = null;
  }
  await Promise.all(pending);
};

// Очистка доменных таблиц. Вызывается в beforeEach из под migrator-роли —
// иначе RLS/permission не пропустят TRUNCATE.
//
// После TRUNCATE companies CASCADE Postgres автоматически чистит все таблицы
// с FK на companies — включая product_categories и products, даже строки
// с company_id IS NULL. Поэтому re-seed платформенных категорий делаем
// в конце. Единицы (units) не имеют FK на companies — не чистятся.
export const truncateAll = async (): Promise<void> => {
  const { pool } = getSetupDb();
  await pool.query(`
    TRUNCATE TABLE
      audit_log,
      api_keys,
      sessions,
      invitations,
      identities,
      estimate_versions,
      estimate_line_items,
      estimate_sections,
      estimates,
      projects,
      memberships,
      users,
      companies
    RESTART IDENTITY CASCADE;
  `);
  // Re-seed платформенных категорий — идентично миграции 0009. Каждый тест
  // получает свежую платформу с теми же кодами.
  await pool.query(`
    INSERT INTO product_categories (company_id, source, code, name, sort_order) VALUES
      (NULL, 'platform', 'video',    'Видеонаблюдение',        10),
      (NULL, 'platform', 'audio',    'Аудио и переговорные',   20),
      (NULL, 'platform', 'security', 'Охрана (СКУД, датчики)', 30),
      (NULL, 'platform', 'network',  'Сетевое оборудование',   40),
      (NULL, 'platform', 'cable',    'Кабели',                 50),
      (NULL, 'platform', 'power',    'Питание',                60),
      (NULL, 'platform', 'mount',    'Крепёж и монтаж',        70),
      (NULL, 'platform', 'other',    'Прочее',                 90);
  `);
};
