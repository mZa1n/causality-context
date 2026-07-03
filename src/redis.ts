import { adoptContext, forkContext, type CausalityContext } from "./context.js";

export type WithMeta<T> = {
    meta: {
        correlation_id: string;
        causation_id?: string;
        execution_id: string;
    };
    data: T;
};

export function wrapRedisPayload<T>(data: T, ctx?: CausalityContext): WithMeta<T> {
    const c = ctx ?? forkContext();
    return {
        meta:  {
            correlation_id: c.correlationId,
            ...(c.causationId ? { causation_id: c.causationId } : {}),
            execution_id: c.executionId,
        },
        data,
    };
}

export function unwrapRedisPayload<T = unknown>(raw: unknown): { ctx: CausalityContext, data: T } {
    if (raw && typeof raw === 'object' && 'meta' in raw && 'data' in raw && (raw as any).meta) {
        const m = (raw as WithMeta<T>).meta;
        return {
            ctx: adoptContext({
                correlationId: m.correlation_id,
                causationId: m.causation_id,
                executionId: m.execution_id,
            }),
            data: (raw as WithMeta<T>).data,
        };
    }
    return { ctx: forkContext(), data: raw as T };
}
