import { createRequire } from 'node:module';
import type { PyroscopeConfig } from '@pyroscope/nodejs';

type PyroscopeModule = typeof import('@pyroscope/nodejs');

const require = createRequire(import.meta.url);

let pyroscope: PyroscopeModule | undefined;
let started = false;

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = optional(process.env[name])?.toLocaleLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function numberEnv(name: string): number | undefined {
  const value = optional(process.env[name]);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tagsFromEnv(): Record<string, string> {
  const tags: Record<string, string> = {};
  const nodeEnv = optional(process.env.NODE_ENV);
  if (nodeEnv) tags.environment = nodeEnv;
  for (const pair of optional(process.env.PYROSCOPE_TAGS)?.split(',') ?? []) {
    const [rawKey, ...rawValue] = pair.split('=');
    const key = rawKey?.trim();
    const value = rawValue.join('=').trim();
    if (key && value) tags[key] = value;
  }
  return tags;
}

export function startPyroscopeFromEnv(): void {
  if (started) return;
  const serverAddress = optional(process.env.PYROSCOPE_SERVER_ADDRESS);
  const enabled = boolEnv('PYROSCOPE_ENABLED', Boolean(serverAddress));
  if (!enabled) return;
  if (!serverAddress) {
    console.warn(
      '[causality-context] PYROSCOPE_ENABLED is set, but PYROSCOPE_SERVER_ADDRESS is empty',
    );
    return;
  }
  const appName =
    optional(process.env.PYROSCOPE_APPLICATION_NAME) ??
    optional(process.env.OTEL_SERVICE_NAME) ??
    optional(process.env.SERVICE_NAME) ??
    'unknown-service';
  const config: PyroscopeConfig = {
    serverAddress,
    appName,
    basicAuthUser: optional(process.env.PYROSCOPE_BASIC_AUTH_USER),
    basicAuthPassword: optional(process.env.PYROSCOPE_BASIC_AUTH_PASSWORD),
    authToken: optional(process.env.PYROSCOPE_AUTH_TOKEN),
    tenantID: optional(process.env.PYROSCOPE_TENANT_ID),
    tags: tagsFromEnv(),
    wall: {
      collectCpuTime: boolEnv('PYROSCOPE_WALL_COLLECT_CPU_TIME', true),
      samplingDurationMs: numberEnv('PYROSCOPE_WALL_SAMPLING_DURATION_MS'),
      samplingIntervalMicros: numberEnv('PYROSCOPE_WALL_SAMPLING_INTERVAL_MS'),
    },
    heap: {
      samplingIntervalBytes: numberEnv(
        'PYROSCOPE_HEAP_SAMPLING_INTERVAL_BYTES',
      ),
      stackDepth: numberEnv('PYROSCOPE_HEAP_STACK_DEPTH'),
    },
  };
  try {
    pyroscope = require('@pyroscope/nodejs') as PyroscopeModule;
    pyroscope.init(config);
    pyroscope.start();
    started = true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[causality-context] Pyroscope profiler was not started: ${message}`,
    );
  }
}

export async function stopPyroscope(): Promise<void> {
  if (!started || !pyroscope) return;
  await pyroscope.stop();
  started = false;
}

startPyroscopeFromEnv();
