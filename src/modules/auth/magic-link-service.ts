import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { magicLinkTokens, type MagicLinkToken } from '../../db/schema/index.js';
import { runWithoutCompanyContext } from '../../plugins/with-company-context.js';
import { ValidationError, RateLimitError, UnauthorizedError } from '../../lib/errors.js';
import { type EmailSender } from '../../lib/email/sender.js';
import * as repo from './repo.js';

// Пороги защиты. Держим низкими, чтобы юзер не мог случайно засыпать почту
// спамом при повторных кликах, и злоумышленник не мог enumerate'ить адреса.
const MAX_ACTIVE_TOKENS_PER_EMAIL = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Нормализуем email: trim + lowercase. То же самое делает бэк на регистрации,
// иначе юзер напишет 'Vasya@Mail.RU' в форме, а в БД будет 'vasya@mail.ru'.
const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

// SHA-256 в hex. 32 байта энтропии в token → sha256 неломаемый на практике,
// argon2 сюда избыточен.
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// Генерируем URL-безопасный токен: 32 байта → 43 символа base64url.
const generateToken = (): string => randomBytes(32).toString('base64url');

// ── Start ────────────────────────────────────────────────────────

export type StartInput = {
  email: string;
  ip: string | null;
  userAgent: string | null;
};

export const startMagicLink = async (
  db: Db,
  email: EmailSender,
  frontendUrl: string,
  ttlMinutes: number,
  input: StartInput,
): Promise<void> => {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail.includes('@') || normalizedEmail.length < 3) {
    // На этом уровне уже отсекли zod'ом, но подстрахуем.
    throw new ValidationError('Некорректный email');
  }

  await runWithoutCompanyContext(db, async (tx) => {
    // Rate-limit по email: не даём завести > N активных ссылок разом.
    // Отдельный rate-limit по IP делается @fastify/rate-limit на роуте.
    const [activeCount] = await tx
      .select({ value: count() })
      .from(magicLinkTokens)
      .where(
        and(
          eq(magicLinkTokens.email, normalizedEmail),
          isNull(magicLinkTokens.usedAt),
          gt(magicLinkTokens.expiresAt, sql`now()`),
        ),
      );
    if ((activeCount?.value ?? 0) >= MAX_ACTIVE_TOKENS_PER_EMAIL) {
      throw new RateLimitError(
        'Слишком много ссылок на этот email. Подождите, пока предыдущие истекут.',
      );
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await tx.insert(magicLinkTokens).values({
      email: normalizedEmail,
      tokenHash,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    const link = `${frontendUrl}?token=${encodeURIComponent(token)}`;
    await email.sendMagicLink({
      to: normalizedEmail,
      link,
      ttlMinutes,
    });
  });
};

// ── Verify ───────────────────────────────────────────────────────

export type VerifyInput = {
  token: string;
  ip: string | null;
  userAgent: string | null;
  sessionTtlDays: number;
};

export type VerifyResult = {
  sessionId: string;
  userId: string;
  membershipId: string;
  isNewUser: boolean;
};

const DEFAULT_COMPANY_NAME = 'Моя компания';

export const verifyMagicLink = async (db: Db, input: VerifyInput): Promise<VerifyResult> => {
  const tokenHash = hashToken(input.token);

  return runWithoutCompanyContext(db, async (tx) => {
    // Активный ≠ использованный + не истёк.
    const found = await findActiveToken(tx, tokenHash);
    if (!found) {
      // Обобщённая ошибка — не даём атакующему различить «нет такого»,
      // «уже использован» и «истёк».
      throw new UnauthorizedError('Ссылка недействительна или уже использована');
    }

    // Помечаем токен как использованный ДО создания сессии — если создание
    // сессии упадёт, токен всё равно сгорит, а не даст ещё одну попытку.
    await tx
      .update(magicLinkTokens)
      .set({ usedAt: sql`now()` })
      .where(eq(magicLinkTokens.id, found.id));

    // Ищем юзера. Если нет — новый (аналог первого захода через OAuth).
    let userId: string;
    let isNewUser = false;
    const existingUser = await repo.findUserByEmail(tx, found.email);
    if (existingUser) {
      userId = existingUser.id;
    } else {
      isNewUser = true;
      // Имя из локальной части email — юзер потом сможет поменять в
      // настройках профиля. Пусто оставлять нельзя: UI ждёт что-то показать
      // в аватарке и меню.
      const localPart = found.email.split('@')[0] ?? found.email;
      const user = await repo.insertUser(tx, {
        email: found.email,
        passwordHash: null,
        name: localPart,
      });
      const company = await repo.insertCompany(tx, DEFAULT_COMPANY_NAME);
      await repo.insertMembership(tx, {
        userId: user.id,
        companyId: company.id,
        role: 'owner',
      });
      userId = user.id;
    }

    const activeMemberships = await repo.listActiveMembershipsForUser(tx, userId);
    const usable = activeMemberships.filter((m) => m.status === 'active');
    const active = usable[0];
    if (!active) {
      throw new UnauthorizedError('У пользователя нет активной компании');
    }

    const expiresAt = new Date(Date.now() + input.sessionTtlDays * DAY_MS);
    const sessionId = await repo.insertSession(tx, {
      userId,
      activeMembershipId: active.membershipId,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      sessionId,
      userId,
      membershipId: active.membershipId,
      isNewUser,
    };
  });
};

const findActiveToken = async (tx: Db, tokenHash: string): Promise<MagicLinkToken | undefined> => {
  const rows = await tx
    .select()
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        isNull(magicLinkTokens.usedAt),
        gt(magicLinkTokens.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return rows[0];
};
