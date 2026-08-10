import { buildApp } from './app.js';

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

async function main(): Promise<void> {
  const app = await buildApp({ logger: true });
  let closing = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'graceful shutdown started');
    const forceExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    await app.close();
    clearTimeout(forceExit);
  };

  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'graceful shutdown failed');
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));

  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: parsePort(process.env.PORT),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Cortex startup failed.');
  process.exitCode = 1;
});
