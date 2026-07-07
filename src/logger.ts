import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import {
  logs,
  SeverityNumber,
  type LogAttributes,
} from '@opentelemetry/api-logs';
import { getCurrentContext } from './context.js';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

const LEVEL_TEXT: Record<Level, string> = {
  log: 'info',
  error: 'error',
  warn: 'warning',
  debug: 'debug',
  verbose: 'debug',
};

const SEVERITY: Record<Level, SeverityNumber> = {
  log: SeverityNumber.INFO,
  error: SeverityNumber.ERROR,
  warn: SeverityNumber.WARN,
  debug: SeverityNumber.DEBUG,
  verbose: SeverityNumber.TRACE,
};

function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const c = span.spanContext();
  return { trace_id: c.traceId, span_id: c.spanId };
}

export function withContextFields<T extends Record<string, unknown>>(f: T) {
  const ctx = getCurrentContext();
  const tf = traceFields();
  if (!ctx) return { ...f, ...tf };
  return {
    ...f,
    flow_id: ctx.flowId,
    step_id: ctx.stepId,
    ...(ctx.parentStepId ? { parent_step_id: ctx.parentStepId } : {}),
    ...tf,
  };
}

export class CausalityLogger implements LoggerService {
  constructor(private readonly service: string) {}

  private write(
    level: Level,
    message: unknown,
    meta?: Record<string, unknown>,
  ) {
    const context = (meta?.context as string) ?? undefined;
    const logger = context ? `${this.service}.${context}` : this.service;
    const exception = (meta?.exception as string) ?? undefined;
    const payload =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : { event: String(message) };

    const event = String(payload.event ?? 'log');
    const { event: _event, ...payloadAttributes } = payload;

    const record: Record<string, unknown> = {
      ...payloadAttributes,
      timestamp: new Date().toISOString().replace('Z', '000Z'),
      ...(exception ? { exception } : {}),
    };

    logs.getLogger(logger).emit({
      severityNumber: SEVERITY[level],
      severityText: LEVEL_TEXT[level],
      body: event,
      attributes: record as LogAttributes,
    });
  }

  log(m: unknown, ...r: unknown[]) {
    this.write('log', m, metaOf(r));
  }
  error(m: unknown, ...r: unknown[]) {
    this.write('error', m, metaOf(r, true));
  }
  warn(m: unknown, ...r: unknown[]) {
    this.write('warn', m, metaOf(r));
  }
  debug(m: unknown, ...r: unknown[]) {
    this.write('debug', m, metaOf(r));
  }
  verbose(m: unknown, ...r: unknown[]) {
    this.write('verbose', m, metaOf(r));
  }
}

function metaOf(
  rest: unknown[],
  withException = false,
): Record<string, unknown> {
  const strings = rest.filter((r) => typeof r === 'string') as string[];
  const context = strings.find((s) => !s.includes('\n'));
  const stack = withException
    ? strings.find((s) => s.includes('\n'))
    : undefined;
  return {
    ...(context ? { context } : {}),
    ...(stack ? { exception: stack } : {}),
  };
}

function strip(meta: Record<string, unknown>) {
  const { context, exception, ...rest } = meta;
  return rest;
}
