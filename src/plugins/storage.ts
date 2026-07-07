import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';
import { LocalFileStorage } from '../storage/local-file-storage.js';
import { type FileStorage } from '../storage/file-storage.js';

// Декоратор app.storage. MVP-реализация — LocalFileStorage, путь берётся
// из config.UPLOADS_DIR. Прод-подмена на S3-реализацию — здесь же.
declare module 'fastify' {
  interface FastifyInstance {
    storage: FileStorage;
  }
}

const storagePlugin: FastifyPluginAsync = async (app) => {
  const storage = new LocalFileStorage(app.config.UPLOADS_DIR);
  app.decorate('storage', storage);
};

export default fp(storagePlugin, { name: 'storage', dependencies: [] });
