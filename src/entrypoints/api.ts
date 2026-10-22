import 'reflect-metadata';
import { createCore } from '../bootstrap/core';
import { createNestApp } from '../bootstrap/nest/create-app';
import { ApiModule } from '../bootstrap/nest/modules';
import { runProcess } from '../bootstrap/process-runner';

/** HTTP API process (scaled horizontally behind nginx). Runs no background workers. */
void runProcess('api', async (config) => {
  const core = await createCore(config);
  const app = await createNestApp(core, ApiModule.register(core));
  await app.listen(config.http.port, '0.0.0.0');
  core.logger.info('API listening', { port: config.http.port, authMode: config.authMode });
  if (config.authMode === 'none') {
    core.logger.warn('AUTH_MODE=none: provider identity is NOT verified (local development only)');
  }
});
