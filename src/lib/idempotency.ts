import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { type Db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';

import { ConflictError, ValidationError } from './errors.js';

const uuidSchema = z.string().uuid();

// Мутирующие эндпоинты (POST/PATCH/DELETE) оборачиваются в withIdempotency —
// если клиент прислал заголовок Idempotency-Key: <uuid>, повторный запрос с тем
// же ключом (двойной клик, ретрай при таймауте) вернёт кешированный ответ, не
// выполняя мутацию повторно.
//
// Соглашение: ключ уникален в пределах пары (метод, путь). Один и тот же uuid
// на POST /line-items и PATCH /line-items/:id — валидная ситуация (разные
// операции с одной темой), но использовать один ключ на «создать» и «удалить»
// нельзя — тогда возвращаем 409.
//
// Запись ключа идёт в ТОЙ ЖЕ транзакции, что и мутация — если commit провалится,
// ключ тоже не сохранится, ретрай пройдёт нормально.
export const withIdempotency = async <T>(
  tx: Db,
  ctx: { companyId: string; userId: string },
  method: string,
  path: string,
  headerValue: string | undefined,
  handler: () => Promise<T>,
): Promise<T> => {
  if (!headerValue) return handler();

  const parsed = uuidSchema.safeParse(headerValue);
  if (!parsed.success) {
    throw new ValidationError('Заголовок Idempotency-Key должен быть UUID');
  }
  const key = parsed.data;

  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.method !== method || row.path !== path) {
      throw new ConflictError(
        'Idempotency-Key уже использовался с другим методом или путём — сгенерируйте новый ключ',
      );
    }
    return row.responseBody as T;
  }

  const result = await handler();

  await tx.insert(idempotencyKeys).values({
    key,
    companyId: ctx.companyId,
    userId: ctx.userId,
    method,
    path,
    statusCode: 200,
    responseBody: result as unknown as Record<string, unknown>,
  });

  return result;
};
