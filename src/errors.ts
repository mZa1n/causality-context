import { trace } from '@opentelemetry/api';

export type ErrorSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface ErrorEventPayload {
  source: 'error' | 'bug';
  severity: ErrorSeverity;
  service: string;
  title: string;
  message: string;
  stacktrace?: string;
  userId?: string;
  sid?: string;
  traceId?: string;
  tags?: Record<string, string>;
  occurredAt: string;
}

export interface NatsPublisher {
  publish(subject: string, data: unknown): void;
}

export interface PublishErrorInput {
  severity: ErrorSeverity;
  title: string;
  message?: string;
  error?: string;
  tags?: Record<string, string>;
  service?: string;
  subject?: string;
}

export interface PublishBugInput {
  title: string;
  message: string;
  userId?: string;
  sid?: string;
  severity?: ErrorSeverity;
  tags?: Record<string, string>;
}

interface PublisherConfig {
  service: string;
  errorSubjectBase: string;
  bugSubject: string;
}

const config: PublisherConfig = {
  service:
    process.env.SERVICE_NAME ?? process.env.OTEL_SERVICE_NAME ?? 'unknown',
  errorSubjectBase: process.env.ERROR_SUBJECT_BASE ?? 'events.error',
  bugSubject: process.env.BUG_SUBJECT ?? 'events.bug.user',
};

export function configureErrorPublisher(cfg: Partial<PublisherConfig>): void {
  Object.assign(config, cfg);
}

function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const id = span?.spanContext().traceId;
  if (!id || /^0+$/.test(id)) return undefined;
  return id;
}

function extractError(error: unknown): {
  message: string;
  stacktrace?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stacktrace: error.stack,
    };
  }
  if (typeof error === 'string') return { message: error };
  if (error === null) return { message: '' };
  try {
    return {
      message: JSON.stringify(error),
    };
  } catch {
    return { message: String(error) };
  }
}

export function publishError(
  nats: NatsPublisher,
  input: PublishErrorInput,
): void {
  const service = input.service ?? config.service;
  const fromError =
    input.error !== undefined ? extractError(input.error) : undefined;
  const traceId = currentTraceId();
  const payload: ErrorEventPayload = {
    source: 'error',
    severity: input.severity,
    service,
    title: input.title,
    message: input.message ?? fromError?.message ?? '',
    ...(fromError?.stacktrace ? { stacktrace: fromError.stacktrace } : {}),
    ...(traceId ? { traceId } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    occurredAt: new Date().toISOString(),
  };
  const subject = input.subject ?? `${config.errorSubjectBase}.${service}`;
  nats.publish(subject, payload);
}

export function publishBug(nats: NatsPublisher, input: PublishBugInput): void {
  const traceId = currentTraceId();
  const payload: ErrorEventPayload = {
    source: 'bug',
    severity: input.severity ?? 'info',
    service: config.service,
    title: input.title,
    message: input.message,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.sid ? { sid: input.sid } : {}),
    ...(traceId ? { traceId } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    occurredAt: new Date().toISOString(),
  };
  nats.publish(config.bugSubject, payload);
}
