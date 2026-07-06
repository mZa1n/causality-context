import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
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

const PRETTY =
    process.env.LOG_PRETTY === '1' || process.env.NODE_ENV !== 'production';

export function withContextFields<T extends Record<string, unknown>>(
    fields: T,
) {
    const ctx = getCurrentContext();
    const span = trace.getActiveSpan();
    const tf = span
        ? { trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId }
        : {};
    if (!ctx) return { ...fields, ...tf };
    return {
        ...fields,
        flow_id: ctx.flowId,
        step_id: ctx.stepId,
        ...(ctx.parentStepId ? { parent_step_id: ctx.parentStepId } : {}),
        ...tf,
    };
}

export class CausalityLogger implements LoggerService {
    private readonly otel = logs.getLogger('causality');

    constructor(private readonly service: string) {}

    private write(
        level: Level,
        message: unknown,
        meta?: Record<string, unknown>,
    ) {
        const msg = typeof message === 'string' ? message : String(message);
        const context = (meta?.context as string) ?? undefined;
        const loggerName = context ? `${this.service}.${context}` : this.service;
        const ctx = getCurrentContext();
        const extra = meta ? stripContext(meta) : {};

        this.otel.emit({
            severityNumber: SEVERITY[level],
            severityText: LEVEL_TEXT[level],
            body: msg,
            attributes: {
                event: msg,
                logger: loggerName,
                level: LEVEL_TEXT[level],
                ...(ctx
                    ? {
                        flow_id: ctx.flowId,
                        step_id: ctx.stepId,
                        ...(ctx.parentStepId ? { parent_step_id: ctx.parentStepId } : {}),
                    }
                    : {}),
                ...extra,
            },
        });
        if (PRETTY) {
            const ids = ctx ? `flow=${ctx.flowId.slice(0, 8)}` : '';
            process.stdout.write(
                `${LEVEL_TEXT[level].toUpperCase()} [${loggerName}] ${msg} ${ids}\n`,
            );
        } else {
            const record = {
                event: msg,
                level: LEVEL_TEXT[level],
                logger: loggerName,
                timestamp: new Date().toISOString().replace('Z', '000Z'),
                ...withContextFields(extra),
            };
            const out = JSON.stringify(record);
            if (level === 'error') process.stderr.write(out + '\n');
            else process.stdout.write(out + '\n');
        }
    }

    log(m: unknown, ...r: unknown[]) {
        this.write('log', m, metaOf(r));
    }
    error(m: unknown, ...r: unknown[]) {
        this.write('error', m, metaOf(r));
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

function metaOf(rest: unknown[]): Record<string, unknown> {
    const context = rest.find((r) => typeof r === 'string') as string | undefined;
    return context ? { context } : {};
}

function stripContext(meta: Record<string, unknown>) {
    const { context, ...rest } = meta;
    return rest;
}