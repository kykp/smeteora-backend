import { z } from 'zod';

import { ConflictError, ValidationError } from './errors.js';

// Клиент шлёт заголовок If-Match: <number> с текущей version сметы (или
// другого агрегата). Сервис при UPDATE делает WHERE version = <expected>
// RETURNING — если строка не вернулась, значит кто-то уже успел обновить,
// возвращаем 409.
//
// Клиент должен рефетчнуть свежее состояние и перепринять правки — или
// показать модалку «данные устарели» + перезагрузить.
//
// If-Match опциональный: если клиент не прислал — версия не проверяется
// (для случаев одноюзерных сценариев или бэковых батчей).

const versionSchema = z.coerce.number().int().min(1);

export const parseIfMatch = (headerValue: string | undefined): number | null => {
  if (!headerValue) return null;
  const parsed = versionSchema.safeParse(headerValue);
  if (!parsed.success) {
    throw new ValidationError('Заголовок If-Match должен быть положительным целым числом');
  }
  return parsed.data;
};

// Бросает ConflictError с текущей version в теле — клиент показывает её юзеру
// или сам рефетчит. Используется когда UPDATE вернул 0 строк.
export const throwVersionConflict = (currentVersion: number | null): never => {
  throw new ConflictError(
    currentVersion === null
      ? 'Смета была изменена или удалена другим пользователем — обновите страницу'
      : `Смета была изменена другим пользователем (актуальная версия ${currentVersion}) — обновите страницу`,
  );
};
