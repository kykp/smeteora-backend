import { createHash, randomInt } from 'node:crypto';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { emailOtpCodes, type EmailOtpCode } from '../../db/schema/index.js';
import { runWithoutCompanyContext } from '../../plugins/with-company-context.js';
import { ValidationError, RateLimitError, UnauthorizedError } from '../../lib/errors.js';
import { type EmailSender } from '../../lib/email/sender.js';
import { buildAuthResponse } from './service.js';
import { type AuthUserResponse } from './schema.js';
import * as repo from './repo.js';

// Пороги защиты. Держим низкими, чтобы юзер не мог случайно засыпать почту
// спамом при повторных запросах, и злоумышленник не мог enumerate'ить адреса.
const MAX_ACTIVE_CODES_PER_EMAIL = 5;
// Сколько неверных попыток verify выдерживает один код до инвалидации.
// 6-значный код = 10^6 вариантов, поэтому подобрать «случайно» за 5 попыток
// невозможно (P < 5e-6). После 5 промахов код инвалидируется.
const MAX_VERIFY_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Нормализуем email: trim + lowercase. То же самое делает бэк на регистрации,
// иначе юзер напишет 'Vasya@Mail.RU' в форме, а в БД будет 'vasya@mail.ru'.
const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

// SHA-256 в hex. Кодовое пространство маленькое (10^6), но защиту обеспечивает
// не хэш, а attempts-счётчик + rate-limit + связка (email, code): подобрать
// «любой активный код» невозможно, только код для конкретного email.
const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

// 6-значный код с ведущими нулями. randomInt даёт криптостойкую случайность,
// а String.padStart сохраняет длину для «007123» и подобных.
const generateCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');

// ── Start ────────────────────────────────────────────────────────

export type StartInput = {
  email: string;
  ip: string | null;
  userAgent: string | null;
};

export const startEmailOtp = async (
  db: Db,
  email: EmailSender,
  ttlMinutes: number,
  input: StartInput,
): Promise<void> => {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail.includes('@') || normalizedEmail.length < 3) {
    // На этом уровне уже отсекли zod'ом, но подстрахуем.
    throw new ValidationError('Некорректный email');
  }

  await runWithoutCompanyContext(db, async (tx) => {
    // Rate-limit по email: не даём завести > N активных кодов разом.
    // Отдельный rate-limit по IP делается @fastify/rate-limit на роуте.
    const [activeCount] = await tx
      .select({ value: count() })
      .from(emailOtpCodes)
      .where(
        and(
          eq(emailOtpCodes.email, normalizedEmail),
          isNull(emailOtpCodes.usedAt),
          gt(emailOtpCodes.expiresAt, sql`now()`),
        ),
      );
    if ((activeCount?.value ?? 0) >= MAX_ACTIVE_CODES_PER_EMAIL) {
      throw new RateLimitError(
        'Слишком много кодов на этот email. Подождите, пока предыдущие истекут.',
      );
    }

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await tx.insert(emailOtpCodes).values({
      email: normalizedEmail,
      codeHash,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    await email.sendEmailOtp({
      to: normalizedEmail,
      code,
      ttlMinutes,
    });
  });
};

// ── Verify ───────────────────────────────────────────────────────

export type VerifyInput = {
  email: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
  sessionTtlDays: number;
};

export type VerifyResult = {
  sessionId: string;
  response: AuthUserResponse;
  isNewUser: boolean;
};

const DEFAULT_COMPANY_NAME = 'Моя компания';

export const verifyEmailOtp = async (db: Db, input: VerifyInput): Promise<VerifyResult> => {
  const normalizedEmail = normalizeEmail(input.email);
  const codeHash = hashCode(input.code);

  return runWithoutCompanyContext(db, async (tx) => {
    // Ищем ЛЮБОЙ активный код по email, а не по паре (email, code_hash).
    // Это нужно чтобы промах увеличивал счётчик именно у последнего кода
    // юзера, а не пропадал «в никуда» — иначе attempts-защиту легко обойти,
    // подбирая коды по одному без ограничений.
    const found = await findLatestActiveCodeByEmail(tx, normalizedEmail);
    if (!found) {
      // Обобщённая ошибка — не даём атакующему различить «нет такого email»,
      // «код истёк» и «код неверный».
      throw new UnauthorizedError('Код недействителен или уже использован');
    }

    if (found.codeHash !== codeHash) {
      // Промах: инкрементим счётчик. Если превысили лимит — гасим код,
      // чтобы дальнейшие попытки на этом же email требовали /start.
      const nextAttempts = found.attempts + 1;
      if (nextAttempts >= MAX_VERIFY_ATTEMPTS) {
        await tx
          .update(emailOtpCodes)
          .set({ attempts: nextAttempts, usedAt: sql`now()` })
          .where(eq(emailOtpCodes.id, found.id));
      } else {
        await tx
          .update(emailOtpCodes)
          .set({ attempts: nextAttempts })
          .where(eq(emailOtpCodes.id, found.id));
      }
      throw new UnauthorizedError('Код недействителен или уже использован');
    }

    // Помечаем код как использованный ДО создания сессии — если создание
    // сессии упадёт, код всё равно сгорит, а не даст ещё одну попытку.
    await tx
      .update(emailOtpCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(emailOtpCodes.id, found.id));

    // Ищем юзера. Если нет — новый (аналог первого захода через OAuth).
    let userId: string;
    let isNewUser = false;
    const existingUser = await repo.findUserByEmail(tx, normalizedEmail);
    if (existingUser) {
      userId = existingUser.id;
    } else {
      isNewUser = true;
      // Имя из локальной части email — юзер потом сможет поменять в
      // настройках профиля. Пусто оставлять нельзя: UI ждёт что-то показать
      // в аватарке и меню.
      const localPart = normalizedEmail.split('@')[0] ?? normalizedEmail;
      const user = await repo.insertUser(tx, {
        email: normalizedEmail,
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

    const response = await buildAuthResponse(tx, {
      userId,
      membershipId: active.membershipId,
    });

    return { sessionId, response, isNewUser };
  });
};

// Берём самый свежий активный код на email. Активный = не использован,
// не истёк. Кодов может быть несколько (юзер нажал «прислать снова»),
// но для verify актуален последний.
const findLatestActiveCodeByEmail = async (
  tx: Db,
  email: string,
): Promise<EmailOtpCode | undefined> => {
  const rows = await tx
    .select()
    .from(emailOtpCodes)
    .where(
      and(
        eq(emailOtpCodes.email, email),
        isNull(emailOtpCodes.usedAt),
        gt(emailOtpCodes.expiresAt, sql`now()`),
      ),
    )
    .orderBy(sql`${emailOtpCodes.createdAt} desc`)
    .limit(1);
  return rows[0];
};
