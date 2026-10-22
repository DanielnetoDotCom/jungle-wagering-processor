import { loadConfig, type AppConfig } from '../infrastructure/configuration/config';

/**
 * Common process entry: validated configuration, UTC, and a structured fatal
 * log (stderr JSON) when startup fails. Exits non-zero so the orchestrator
 * restarts the process.
 */
export async function runProcess(name: string, main: (config: AppConfig) => Promise<void>): Promise<void> {
  process.env.TZ = 'UTC';
  try {
    const config = loadConfig({ SERVICE_NAME: name, ...process.env });
    await main(config);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'fatal',
        service: name,
        time: new Date().toISOString(),
        message: 'Process failed to start',
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  }
}
