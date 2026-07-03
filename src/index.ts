import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const bootstrap = async (): Promise<void> => {
  const config = loadConfig();
  const app = await buildApp(config);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'graceful shutdown начат');

    const forceExitTimer = setTimeout(() => {
      app.log.fatal('graceful shutdown превысил лимит, форсированный выход');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await app.close();
      app.log.info('graceful shutdown завершён');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'ошибка при graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', (sig) => void shutdown(sig));
  process.on('SIGINT', (sig) => void shutdown(sig));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception, аварийный выход');
    process.exit(1);
  });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'не удалось запустить HTTP-сервер');
    process.exit(1);
  }
};

void bootstrap();
