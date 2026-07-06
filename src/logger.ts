import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

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

function traceFields(): Record<string, string> {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const c = span.spanContext();
    return { trace_id: c.traceId, span_id: c.spanId };
}

export class CausalityLogger implements LoggerService {
    private readonly otel = logs.getLogger('causality');

    constructor(private readonly service: string) {}

    private write(
        level: Level,
        message: unknown,
        meta?: Record<string, unknown>,
    ) {
        const event = typeof message === 'string' ? message : String(message);
        const context = (meta?.context as string) ?? undefined;
        const logger = context ? `${this.service}.${context}` : this.service;
        const exception = (meta?.exception as string) ?? undefined;
        const extra = meta ? strip(meta) : {};
        const tf = traceFields();

        const record: Record<string, unknown> = {
            event,
            level: LEVEL_TEXT[level],
            ...tf,
            logger,
            timestamp: new Date().toISOString().replace('Z', '000Z'),
            ...(exception ? { exception } : {}),
            ...extra,
        };

        this.otel.emit({
            severityNumber: SEVERITY[level],
            severityText: LEVEL_TEXT[level],
            body: event,
            attributes: {
                event,
                level: LEVEL_TEXT[level],
                logger,
                ...(exception ? { exception } : {}),
                ...extra,
            },
        });

        if (PRETTY) {
            process.stdout.write(`${LEVEL_TEXT[level].toUpperCase()} [${logger}] ${event}\n`);
        } else {
            const out = JSON.stringify(record);
            if (level === 'error') process.stderr.write(out + '\n');
            else process.stdout.write(out + '\n');
        }
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

function metaOf(rest: unknown[], withException = false): Record<string, unknown> {
    const strings = rest.filter((r) => typeof r === 'string') as string[];
    const context = strings.find((s) => !s.includes('\n'));
    const stack = withException ? strings.find((s) => s.includes('\n')) : undefined;
    return {
        ...(context ? { context } : {}),
        ...(stack ? { exception: stack } : {}),
    };
}

function strip(meta: Record<string, unknown>) {
    const { context, exception, ...rest } = meta;
    return rest;
}
