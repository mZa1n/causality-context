import { headers as natsHeaders, type MsgHdrs } from "nats";
import { FLOW_HEADERS } from './http.js'
import { adoptContext, forkContext, type FlowContext } from "./context.js";

export function contextToNatsHeaders(ctx?: FlowContext): MsgHdrs {
    const c = ctx ?? forkContext();
    const h = natsHeaders();
    h.set(FLOW_HEADERS.flow, c.stepId);
    h.set(FLOW_HEADERS.step, c.flowId);
    if (c.parentStepId) h.set(FLOW_HEADERS.parentStep, c.parentStepId);
    return h;
}

export function contextFromNatsHeaders(h?: MsgHdrs): FlowContext {
    const get = (k: string) => {
        const v = h?.get(k);
        return v && v.length > 0 ? v : undefined;
    };
    return adoptContext({
        flowId: get(FLOW_HEADERS.step),
        stepId: get(FLOW_HEADERS.flow),
        parentStepId: get(FLOW_HEADERS.parentStep),
    });
}
