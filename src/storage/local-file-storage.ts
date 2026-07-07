import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileNotFoundError, type FileStorage, type FileStorageGetResult } from './file-storage.js';

// Локальная реализация FileStorage. Все ключи — относительные пути внутри rootDir.
// rootDir нормализуется абсолютным — от cwd (в dev это корень репо, в prod
// контейнер cwd=/app, значит ./data/uploads → /app/data/uploads).
//
// Sidecar-файл <key>.meta хранит content-type: небольшой JSON, читается только
// при get. Так не пришлось водить content-type через отдельный ORM/индекс —
// в БД он есть в companies.logo_content_type, здесь дублируется на случай
// когда мы утеряли строку из БД или зашли из скрипта.
export class LocalFileStorage implements FileStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  // Ключ — POSIX-путь: `bucket/uuid.png`. Проверяем что после resolve мы всё
  // ещё в rootDir — защита от `../` в ключе, если он вдруг соберётся из
  // непроверенных данных.
  private resolveKey(key: string): string {
    if (key.length === 0) throw new Error('Пустой ключ');
    const full = path.resolve(this.rootDir, key);
    const rel = path.relative(this.rootDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Ключ выходит за пределы rootDir: ${key}`);
    }
    return full;
  }

  async save(key: string, data: Buffer, meta?: { contentType?: string }): Promise<{ key: string }> {
    const full = this.resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    if (meta?.contentType) {
      await fs.writeFile(`${full}.meta`, JSON.stringify({ contentType: meta.contentType }));
    }
    return { key };
  }

  async get(key: string): Promise<FileStorageGetResult> {
    const full = this.resolveKey(key);
    let data: Buffer;
    try {
      data = await fs.readFile(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(key);
      }
      throw err;
    }
    let contentType: string | null = null;
    try {
      const raw = await fs.readFile(`${full}.meta`, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'contentType' in parsed &&
        typeof (parsed as { contentType: unknown }).contentType === 'string'
      ) {
        contentType = (parsed as { contentType: string }).contentType;
      }
    } catch {
      // meta может отсутствовать — не критично, вернём null.
    }
    return { data, contentType };
  }

  async delete(key: string): Promise<void> {
    const full = this.resolveKey(key);
    try {
      await fs.unlink(full);
    } catch (err) {
      // Идемпотентно: удаление отсутствующего файла — не ошибка.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Sidecar тоже сносим, отдельно и с той же логикой.
    try {
      await fs.unlink(`${full}.meta`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const full = this.resolveKey(key);
    try {
      await fs.access(full);
      return true;
    } catch {
      return false;
    }
  }
}
