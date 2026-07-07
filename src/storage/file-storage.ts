// Абстракция файлового хранилища. Локальная реализация — MVP.
// В prod при первом же вопросе о деплое на многосервисный кластер
// заменяется на S3-совместимую реализацию (AWS S3, R2, MinIO) без правки
// вызывающего кода.

export interface FileStorageGetResult {
  readonly data: Buffer;
  readonly contentType: string | null;
}

export interface FileStorage {
  readonly save: (
    key: string,
    data: Buffer,
    meta?: { contentType?: string },
  ) => Promise<{ key: string }>;
  readonly get: (key: string) => Promise<FileStorageGetResult>;
  readonly delete: (key: string) => Promise<void>;
  readonly exists: (key: string) => Promise<boolean>;
}

// Специфичная ошибка «нет такого файла» — реализации бросают её вместо ENOENT/404,
// чтобы вызывающий код проверял `instanceof FileNotFoundError`, а не парсил errno.
export class FileNotFoundError extends Error {
  constructor(key: string) {
    super(`Файл не найден: ${key}`);
    this.name = 'FileNotFoundError';
  }
}
