import type { Request, Response, NextFunction } from 'express';
import {createRootContext, type FlowContext, enterContext} from "./context.js";

export const FLOW_HEADERS = {
    flow: 'x-flow-id',
    step: 'x-step-id',
    parentStep: 'x-parent-step-id',
} as const;

function header(req: Request, name: string): string | undefined {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function contextFromHttpHeaders(req: Request): FlowContext {
    return createRootContext({
        flowId: header(req, FLOW_HEADERS.flow),
        parentStepId:
            header(req, FLOW_HEADERS.step) ??
            header(req, FLOW_HEADERS.parentStep),
    });
}

export function contextToHttpHeaders(ctx: FlowContext): Record<string, string> {
    const out: Record<string, string> = {
        [FLOW_HEADERS.flow]: ctx.flowId,
        [FLOW_HEADERS.step]: ctx.stepId,
    };
    if (ctx.parentStepId) out[FLOW_HEADERS.parentStep] = ctx.parentStepId;
    return out;
}

export function causalityHttpMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        const ctx = contextFromHttpHeaders(req);
        for (const [k, v] of Object.entries(contextToHttpHeaders(ctx))) {
            res.setHeader(k, v);
        }
        enterContext(ctx, () => {
            next();
        });
    };
}
