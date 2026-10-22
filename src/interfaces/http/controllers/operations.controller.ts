import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService, type ReadinessReport } from '../../../infrastructure/health/health.service';
import { PrometheusMetrics } from '../../../infrastructure/metrics/prometheus-metrics';

export const INSTANCE_INFO = Symbol('INSTANCE_INFO');

export interface InstanceInfo {
  serviceName: string;
  instanceId: string;
  startedAt: Date;
}

/** Public, unauthenticated: liveness, readiness and Prometheus scraping. */
@Controller()
export class OperationsController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
    @Inject(INSTANCE_INFO) private readonly instance: InstanceInfo,
  ) {}

  /** The process is up and serving. Does NOT check dependencies. */
  @Get('health/live')
  live(): Record<string, unknown> {
    return {
      status: 'ok',
      service: this.instance.serviceName,
      instanceId: this.instance.instanceId,
      uptimeSeconds: Math.round((Date.now() - this.instance.startedAt.getTime()) / 1000),
    };
  }

  /** 200 when PostgreSQL and SQS answer within the timeout, 503 otherwise. */
  @Get('health/ready')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessReport & { instanceId: string }> {
    const report = await this.health.readiness();
    response.status(report.status === 'ready' ? 200 : 503);
    return { ...report, instanceId: this.instance.instanceId };
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
