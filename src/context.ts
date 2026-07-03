import { AsyncLocalStorage } from 'node:async_hooks';
import { newId } from './ids.js';

export type FlowContext = {
    flowId: string;
    stepId: string;
    parentStepId?: string;
};

const als = new AsyncLocalStorage<FlowContext>();

export function createRootContext(input?: Partial<FlowContext>): FlowContext {
    const id = newId();
    return {
        flowId: input?.flowId ?? id,
        stepId: id,
        parentStepId: input?.parentStepId,
    };
}

export function createChildContext(parent: FlowContext): FlowContext {
    return {
        flowId: parent.flowId,
        stepId: newId(),
        parentStepId: parent.stepId,
    };
}

export function adoptContext(incoming: Partial<FlowContext>): FlowContext {
    const id = newId();
    return {
        flowId: incoming.flowId ?? id,
        stepId: incoming.stepId ?? id,
        parentStepId: incoming.parentStepId,
    };
}

export function forkContext(): FlowContext {
    const cur = als.getStore();
    return cur ? createChildContext(cur) : createRootContext();
}

export function runWithContext<T>(ctx: FlowContext, fn: () => T): T {
    return als.run(ctx, fn);
}

export function enterContext(ctx: FlowContext, fn: () => void): void {
    als.run(ctx, fn);
}

export function getCurrentContext(): FlowContext | undefined {
    return als.getStore();
}