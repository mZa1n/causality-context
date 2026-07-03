import type { LoggerService } from "@nestjs/common";
import { getCurrentContext } from "./context.js";

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

export function withContextFields<T extends Record<string, unknown>>(fields: T): T & { correlation_id?: string; causation_id?: string, execution_id?: string } {
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

    private write (level: Level, message: unknown, meta?: Record<string, unknown>) {
        const base = {
            timestamp: new Date().toISOString(),
            level,
            service: this.service,
            message: typeof message === 'string' ? message : String(message),
            ...(meta ?? {}),
        };
        const line = JSON.stringify(withContextFields(base));
        if (level === 'error') process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
    }
    log(m: unknown, ...rest: unknown[]) { this.write('log', m, restMeta(rest)); }
    error(m: unknown, ...rest: unknown[]) { this.write('error', m, errMeta(rest)); }
    warn(m: unknown, ...rest: unknown[]) { this.write('warn', m, restMeta(rest)); }
    debug(m: unknown, ...rest: unknown[]) { this.write('debug', m, restMeta(rest)); }
    verbose(m: unknown, ...rest: unknown[]) { this.write('verbose', m, restMeta(rest)); }
}

function restMeta(rest: unknown[]): Record<string, unknown> {
    const ctx = rest.find((r) => typeof r === 'string');
    return ctx ? { context: ctx } : {};
}

function errMeta(rest: unknown[]): Record<string, unknown> {
    const meta = restMeta(rest);
    const stack = rest.find((r) => typeof r === 'string' && r.includes('\n'));
    if (stack) meta.stack = stack;
    return meta;
}