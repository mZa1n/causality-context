import type { Request, Response, NextFunction } from 'express';
import { createRootContext, runWithContext, type CausalityContext } from "./context.js";

export const CAUSALITY_HEADERS = {
    correlationId: 'x-correlation-id',
    causationId: 'x-causation-id',
    executionId: 'x-execution-id',
} as const;

function header(req: Request, name: string): string | undefined {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function contextFromHttpHeaders(req: Request): CausalityContext {
    return createRootContext({
        correlationId: header(req, CAUSALITY_HEADERS.correlationId),
        causationId:
            header(req, CAUSALITY_HEADERS.executionId) ??
            header(req, CAUSALITY_HEADERS.causationId),
    });
}

export function contextToHttpHeaders(ctx: CausalityContext): Record<string, string> {
    const out: Record<string, string> = {
        [CAUSALITY_HEADERS.correlationId]: ctx.correlationId,
        [CAUSALITY_HEADERS.executionId]: ctx.executionId,
    };
    if (ctx.causationId) out[CAUSALITY_HEADERS.causationId] = ctx.causationId;
    return out;
}

export function causalityHttpMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        const ctx = contextFromHttpHeaders(req);
        for (const [k,v ] of Object.entries(contextToHttpHeaders(ctx))) {
            res.setHeader(k, v);
        }
        runWithContext(ctx, () => next());
    };
}
