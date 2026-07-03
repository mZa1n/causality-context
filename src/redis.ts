import { adoptContext, forkContext, type FlowContext } from "./context.js";

export type WithMeta<T> = {
    meta: {
        flow_id: string;
        step_id: string;
        parent_step_id?: string;
    };
    data: T;
};

export function wrapRedisPayload<T>(data: T, ctx?: FlowContext): WithMeta<T> {
    const c = ctx ?? forkContext();
    return {
        meta:  {
            flow_id: c.flowId,
            step_id: c.stepId,
            ...(c.parentStepId ? { parent_step_id: c.parentStepId } : {}),
        },
        data,
    };
}

export function unwrapRedisPayload<T = unknown>(raw: unknown): { ctx: FlowContext, data: T } {
    if (raw && typeof raw === 'object' && 'meta' in raw && 'data' in raw && (raw as any).meta) {
        const m = (raw as WithMeta<T>).meta;
        return {
            ctx: adoptContext({
                flowId: m.flow_id,
                stepId: m.step_id,
                parentStepId: m.parent_step_id
            }),
            data: (raw as WithMeta<T>).data,
        };
    }
    return { ctx: forkContext(), data: raw as T };
}
