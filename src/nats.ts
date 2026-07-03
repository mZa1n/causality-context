import { headers as natsHeaders, type MsgHdrs } from "nats";
import { CAUSALITY_HEADERS } from './http.js'
import { adoptContext, forkContext, type CausalityContext } from "./context.js";

export function contextToNatsHeaders(ctx?: CausalityContext): MsgHdrs {
    const c = ctx ?? forkContext();
    const h = natsHeaders();
    h.set(CAUSALITY_HEADERS.correlationId, c.correlationId);
    if (c.causationId) h.set(CAUSALITY_HEADERS.causationId, c.causationId);
    h.set(CAUSALITY_HEADERS.executionId, c.executionId);
    return h;
}

export function contextFromNatsHeaders(h?: MsgHdrs): CausalityContext {
    const get = (k: string) => {
        const v = h?.get(k);
        return v && v.length > 0 ? v : undefined;
    };
    return adoptContext({
        correlationId: get(CAUSALITY_HEADERS.correlationId),
        causationId: get(CAUSALITY_HEADERS.causationId),
        executionId: get(CAUSALITY_HEADERS.executionId),
    });
}
