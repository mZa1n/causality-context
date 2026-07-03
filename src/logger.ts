import type { LoggerService } from '@nestjs/common';
import { getCurrentContext } from './context.js';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

const PRETTY = process.env.LOG_PRETTY === '1' || process.env.NODE_ENV !== 'production';

const c = {
    gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const levelColor: Record<Level, (s: string) => string> = {
    log: c.green,
    error: c.red,
    warn: c.yellow,
    debug: c.cyan,
    verbose: c.gray,
};

export function withContextFields<T extends Record<string, unknown>>(
    fields: T,
) {
    const ctx = getCurrentContext();
    if (!ctx) return fields;
    return {
        ...fields,
        correlation_id: ctx.correlationId,
        ...(ctx.causationId ? { causation_id: ctx.causationId } : {}),
        execution_id: ctx.executionId,
    };
}

export class CausalityLogger implements LoggerService {
    constructor(private readonly service: string) {}

    private write(level: Level, message: unknown, meta?: Record<string, unknown>) {
        const ctx = getCurrentContext();
        const msg = typeof message === 'string' ? message : String(message);
        const context = (meta?.context as string) ?? '';

        if (PRETTY) {
            const time = c.dim(new Date().toLocaleTimeString());
            const lvl = levelColor[level](level.toUpperCase().padEnd(5));
            const ctxTag = context ? c.yellow(`[${context}]`) : '';
            const ids = ctx
                ? c.gray(
                    `corr=${short(ctx.correlationId)} exec=${short(ctx.executionId)}` +
                    (ctx.causationId ? ` caus=${short(ctx.causationId)}` : ''),
                )
                : '';
            const line = `${time} ${lvl} ${ctxTag} ${msg} ${ids}`.replace(/\s+/g, ' ').trim();
            if (level === 'error') process.stderr.write(line + '\n');
            else process.stdout.write(line + '\n');
            return;
        }

        const base = withContextFields({
            timestamp: new Date().toISOString(),
            level,
            service: this.service,
            message: msg,
            ...(meta ?? {}),
        });
        const out = JSON.stringify(base);
        if (level === 'error') process.stderr.write(out + '\n');
        else process.stdout.write(out + '\n');
    }

    log(m: unknown, ...r: unknown[]) { this.write('log', m, metaOf(r)); }
    error(m: unknown, ...r: unknown[]) { this.write('error', m, metaOf(r)); }
    warn(m: unknown, ...r: unknown[]) { this.write('warn', m, metaOf(r)); }
    debug(m: unknown, ...r: unknown[]) { this.write('debug', m, metaOf(r)); }
    verbose(m: unknown, ...r: unknown[]) { this.write('verbose', m, metaOf(r)); }
}

function short(id: string): string {
    const bare = id.replace(/^[a-z]+_/, '');
    return bare.slice(0, 8);
}

function metaOf(rest: unknown[]): Record<string, unknown> {
    const context = rest.find((r) => typeof r === 'string') as string | undefined;
    return context ? { context } : {};
}