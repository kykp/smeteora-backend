import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  DATABASE_URL: z.string().url(),

  // ── Sessions ──
  // openssl rand -hex 32 → 64 hex-символа = 256 бит.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET должен быть ≥ 32 символов'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Домен для cookie. В dev — не задан (пустой), значит cookie работает только на текущем host.
  // В prod — например ".smeteora.ru" чтобы поделиться между api.smeteora.ru и app.smeteora.ru.
  COOKIE_DOMAIN: z.string().optional(),
});

export type Config = Readonly<z.infer<typeof configSchema>> & { readonly version: string };

const readVersion = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof (parsed as { version: unknown }).version !== 'string'
  ) {
    throw new Error('В package.json не найдено строковое поле "version"');
  }
  return (parsed as { version: string }).version;
};

export const loadConfig = (): Config => {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    throw new Error(`Невалидные переменные окружения: ${details}`);
  }
  return Object.freeze({ ...parsed.data, version: readVersion() });
};
