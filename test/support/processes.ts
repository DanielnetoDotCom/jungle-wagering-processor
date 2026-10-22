import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { serviceEnvironment, type TestQueueNames } from './environment';
import { waitFor } from './fixtures';

export type ServiceKind = 'api' | 'consumer' | 'outbox-worker' | 'reference-worker';

const ROOT = resolve(__dirname, '../..');

/** Ports handed out in this test process: the OS may return a just-released port twice. */
const reservedPorts = new Set<number>();

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const candidate = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolvePort(candidate));
      });
    });
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
}

/**
 * A REAL operating-system process running one of the service entrypoints
 * (same code as the containers, executed from TypeScript sources by Bun).
 * Used for multi-instance and crash tests: SIGKILL means no cleanup at all.
 */
export class ServiceProcess {
  private readonly output: string[] = [];

  private constructor(
    readonly kind: ServiceKind,
    readonly port: number,
    private readonly child: Subprocess,
  ) {
    void this.collect(child.stdout as ReadableStream<Uint8Array>);
    void this.collect(child.stderr as ReadableStream<Uint8Array>);
  }

  static async start(params: {
    kind: ServiceKind;
    dbName: string;
    queues?: TestQueueNames;
    env?: Record<string, string>;
    waitUntilReady?: boolean;
    compiled?: boolean;
  }): Promise<ServiceProcess> {
    for (let attempt = 1; ; attempt += 1) {
      const service = await ServiceProcess.spawn(params);
      if (!(params.waitUntilReady ?? true)) return service;
      try {
        await service.waitUntilReady();
        return service;
      } catch (error) {
        // Another process grabbed the port between allocation and listen: try a new one.
        if (attempt < 3 && /in use/i.test(service.logs())) continue;
        throw error;
      }
    }
  }

  private static async spawn(params: {
    kind: ServiceKind;
    dbName: string;
    queues?: TestQueueNames;
    env?: Record<string, string>;
    compiled?: boolean;
  }): Promise<ServiceProcess> {
    const port = await freePort();
    const env = {
      ...process.env,
      ...serviceEnvironment({ dbName: params.dbName, queues: params.queues }),
      LOG_LEVEL: process.env.SPAWN_LOG_LEVEL ?? 'warn',
      SERVICE_NAME: params.kind,
      INSTANCE_ID: `${params.kind}-${port}`,
      HTTP_PORT: String(port),
      METRICS_PORT: String(port),
      DB_POOL_MAX: '10',
      ...params.env,
    };
    const entrypoint = params.compiled
      ? `dist/src/entrypoints/${params.kind}.js`
      : `src/entrypoints/${params.kind}.ts`;
    const child = Bun.spawn(['bun', entrypoint], {
      cwd: ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new ServiceProcess(params.kind, port, child);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get exited(): Promise<number | null> {
    return this.child.exited;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): string | number | null {
    return this.child.signalCode;
  }

  logs(): string {
    return this.output.join('');
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    await waitFor(
      async () => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          throw new Error(
            `${this.kind} exited during startup (${this.child.signalCode ?? this.child.exitCode}):\n${this.logs()}`,
          );
        }
        try {
          const response = await fetch(`${this.url}/health/ready`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { timeoutMs, intervalMs: 200, description: `${this.kind} on port ${this.port} to be ready` },
    );
  }

  /** Abrupt death: no graceful shutdown, no ack, no confirmation. */
  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGKILL');
    await this.child.exited;
  }

  /** Graceful shutdown (SIGTERM), as sent by `docker stop`. */
  async stop(): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.child.exitCode;
    this.child.kill('SIGTERM');
    return this.child.exited;
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.output.push(decoder.decode(chunk));
    }
  }
}

export async function stopAll(services: ServiceProcess[]): Promise<void> {
  await Promise.all(services.map((service) => service.kill()));
}
