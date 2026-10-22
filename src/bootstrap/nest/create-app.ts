import 'reflect-metadata';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestLoggerAdapter } from '../../infrastructure/logging/logger';
import { HttpExceptionFilter } from '../../interfaces/http/support/http-exception.filter';
import {
  bodyParserErrorHandler,
  requestContextMiddleware,
} from '../../interfaces/http/support/request-context';
import type { Core } from '../core';

/**
 * Builds a Nest application with the shared HTTP conventions: correlation
 * context first, strict JSON body parsing with JSON errors, the global error
 * filter and graceful shutdown hooks (SIGTERM/SIGINT).
 */
export async function createNestApp(core: Core, module: DynamicModule): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    bodyParser: false,
    bufferLogs: true,
    logger: new NestLoggerAdapter(core.rootLogger),
  });
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(requestContextMiddleware(core.config.instanceId, core.logger, core.metrics));
  app.useBodyParser('json', { limit: core.config.http.bodyLimit, strict: true });
  app.use(bodyParserErrorHandler());
  app.useGlobalFilters(new HttpExceptionFilter(core.logger));
  app.enableShutdownHooks();
  return app;
}
