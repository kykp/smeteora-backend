import { randomUUID } from 'node:crypto';
import { type Db } from '../../db/client.js';
import { type FileStorage } from '../../storage/file-storage.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import * as repo from './repo.js';
import { LOGO_ALLOWED_MIME, LOGO_MAX_BYTES, type LogoMimeType } from './schema.js';

// Директория внутри FileStorage. Логотипы кладутся по companyId — так при
// компрометации ключа одной компании не утекают файлы других.
const LOGOS_PREFIX = 'company-logos';

const EXT_BY_MIME: Readonly<Record<LogoMimeType, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

const isAllowedMime = (mime: string): mime is LogoMimeType =>
  (LOGO_ALLOWED_MIME as readonly string[]).includes(mime);

// Загрузить логотип. Ротирует старый (удаляет из storage), затем сохраняет
// новый под свежим uuid — при concurrent-заливках второй перезапишет первый
// в БД, но оба файла в storage останутся; первый останется висеть без ссылки.
// Для MVP приемлемо — на масштабе решается фоновой уборкой orphan'ов.
export const uploadLogo = async (
  tx: Db,
  storage: FileStorage,
  params: { companyId: string; data: Buffer; contentType: string },
): Promise<void> => {
  if (!isAllowedMime(params.contentType)) {
    throw new ValidationError(
      `Тип файла не поддерживается: ${params.contentType}. Разрешены: ${LOGO_ALLOWED_MIME.join(', ')}`,
    );
  }
  if (params.data.byteLength > LOGO_MAX_BYTES) {
    throw new ValidationError(`Размер файла превышает ${LOGO_MAX_BYTES} байт`);
  }
  if (params.data.byteLength === 0) {
    throw new ValidationError('Пустой файл');
  }

  const ext = EXT_BY_MIME[params.contentType];
  const key = `${LOGOS_PREFIX}/${params.companyId}/${randomUUID()}.${ext}`;

  // Сохраняем сначала в storage — если БД upsert упадёт, у нас останется висячий
  // файл (orphan), но у пользователя логотип не поменяется. Обратный порядок
  // хуже: сохранил в БД, файл записать не смог → в БД ключ на несуществующий файл.
  const oldMeta = await repo.findLogoMeta(tx, params.companyId);
  await storage.save(key, params.data, { contentType: params.contentType });
  await repo.patch(tx, params.companyId, {
    logoKey: key,
    logoContentType: params.contentType,
  });
  if (oldMeta) {
    // Best-effort уборка старого файла. Ошибку не пробрасываем — БД уже обновлена.
    try {
      await storage.delete(oldMeta.logoKey);
    } catch {
      // Ignore — orphan будет.
    }
  }
};

// Прочитать логотип. Возвращает бинарник + Content-Type для отдачи клиенту.
// 404 если логотип не установлен или файл в storage пропал.
export const readLogo = async (
  tx: Db,
  storage: FileStorage,
  companyId: string,
): Promise<{ data: Buffer; contentType: string }> => {
  const meta = await repo.findLogoMeta(tx, companyId);
  if (!meta) throw new NotFoundError('Логотип не установлен');
  try {
    const file = await storage.get(meta.logoKey);
    return {
      data: file.data,
      // В БД — авторитетный content-type. Sidecar-мета в storage — fallback.
      contentType: meta.logoContentType ?? file.contentType ?? 'application/octet-stream',
    };
  } catch {
    // Файл потерян — трактуем как «нет логотипа».
    throw new NotFoundError('Логотип не найден');
  }
};

// Удалить логотип. Идемпотентно: если логотипа не было — 200 всё равно.
export const deleteLogo = async (
  tx: Db,
  storage: FileStorage,
  companyId: string,
): Promise<void> => {
  const meta = await repo.findLogoMeta(tx, companyId);
  if (!meta) return;
  await repo.patch(tx, companyId, { logoKey: null, logoContentType: null });
  try {
    await storage.delete(meta.logoKey);
  } catch {
    // Игнорим — БД уже без ссылки.
  }
};
