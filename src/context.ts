import { AsyncLocalStorage } from "node:async_hooks";
import { newCorrelationId, newExecutionId } from "./ids.js";

export type CausalityContext = {
    correlationId: string;
    causationId?: string;
    executionId: string;
}

const als = new AsyncLocalStorage<CausalityContext>();

export function createRootContext(
    input?: Partial<CausalityContext>,
): CausalityContext {
    return {
        correlationId: input?.correlationId ?? newCorrelationId(),
        causationId: input?.causationId,
        executionId: newExecutionId(),
    };
}

export function createChildContext(parent: CausalityContext): CausalityContext {
    return {
        correlationId: parent.correlationId,
        causationId: parent.executionId,
        executionId: newExecutionId(),
    }
}

export function adoptContext(incoming: Partial<CausalityContext>): CausalityContext {
    return {
        correlationId: incoming.correlationId ?? newCorrelationId(),
        causationId: incoming.causationId,
        executionId: incoming.executionId ?? newExecutionId(),
    }
}

export function runWithContext<T>(ctx: CausalityContext, fn: () => T): T {
    return als.run(ctx, fn);
}

export function getCurrentContext(): CausalityContext | undefined {
    return als.getStore();
}

export function forkContext(): CausalityContext {
    const cur = als.getStore();
    return cur ? createChildContext(cur) : createRootContext();
}
