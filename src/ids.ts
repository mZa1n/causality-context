import { randomUUID } from "node:crypto";

export function newCorrelationId(): string {
    return `corr_${randomUUID()}`;
}

export function newExecutionId(): string {
    return `exec_${randomUUID()}`;
}