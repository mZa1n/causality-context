import {
    Injectable,
    Logger,
    Module,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import {
    connect,
    NatsConnection,
    StringCodec,
    Subscription,
    headers as natsHeaders,
    type MsgHdrs,
} from 'nats';
import {
    trace,
    context as otelContext,
    propagation,
    SpanKind,
    SpanStatusCode,
} from '@opentelemetry/api';
import {
    contextToNatsHeaders,
    contextFromNatsHeaders,
    runWithContext,
    forkContext,
} from './index.js';

type ReplyHandler = (data: unknown) => Promise<unknown> | unknown;
type EventHandler = (data: unknown, subject: string) => void;

const tracer = trace.getTracer('nats');
const TRACE_EVENTS = process.env.TRACE_EVENTS === '1';

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(NatsService.name);
    private nc?: NatsConnection;
    private readonly sc = StringCodec();
    private readonly subs: Subscription[] = [];
    private readonly replyHandlers = new Map<
        string,
        { queue: string; handler: ReplyHandler }
    >();
    private readonly eventHandlers: { subject: string; handler: EventHandler }[] =
        [];

    onModuleInit() {
        void this.initConnection();
    }

    private async initConnection() {
        const servers = process.env.NATS_URL ?? 'nats://localhost:4222';
        try {
            this.nc = await connect({
                servers,
                reconnect: true,
                maxReconnectAttempts: -1,
                reconnectTimeWait: 2000,
            });
            this.logger.log(`NATS connected: ${servers}`);
            this.monitorConnection();
            this.attachAll();
        } catch (e) {
            this.logger.error(`NATS connect failed (${servers})`, e as Error);
            setTimeout(() => void this.initConnection(), 5000);
        }
    }

    private monitorConnection() {
        if (!this.nc) return;
        (async () => {
            for await (const s of this.nc!.status()) {
                this.logger.log(`NATS status: ${s.type}`);
            }
        })().catch(() => {
        });
    }

    private attachAll() {
        for (const [subject, {queue, handler}] of this.replyHandlers) {
            this.bindReply(subject, queue, handler);
        }
        for (const {subject, handler} of this.eventHandlers) {
            this.bindEvent(subject, handler);
        }
    }

    private injectTrace(h: MsgHdrs) {
        propagation.inject(otelContext.active(), h, {
            set: (carrier, k, v) => (carrier as MsgHdrs).set(k, String(v)),
        });
    }

    private extractTrace(h?: MsgHdrs) {
        return propagation.extract(otelContext.active(), h, {
            get: (carrier, k) => (carrier as MsgHdrs)?.get(k) || undefined,
            keys: (carrier) => (carrier ? [...(carrier as MsgHdrs).keys()] : []),
        });
    }

    async request<T = unknown>(
        subject: string,
        data: unknown,
        timeoutMs = 3000,
    ): Promise<T> {
        if (!this.nc) throw new Error('NATS unavailable');
        const flowCtx = forkContext();
        const h = contextToNatsHeaders(flowCtx);

        return tracer.startActiveSpan(
            `NATS request ${subject}`,
            {
                kind: SpanKind.CLIENT,
                attributes: {
                    'messaging.system': 'nats',
                    'messaging.destination': subject,
                    'flow.id': flowCtx.flowId,
                    'flow.step_id': flowCtx.stepId,
                    ...(flowCtx.parentStepId
                        ? {'flow.parent_step_id': flowCtx.parentStepId}
                        : {}),
                },
            },
            async (span) => {
                this.injectTrace(h);
                await runWithContext(flowCtx, async () =>
                    this.logger.log(`→ request ${subject}`, NatsService.name),
                );
                try {
                    const msg = await this.nc!.request(
                        subject,
                        this.sc.encode(JSON.stringify(data ?? {})),
                        {timeout: timeoutMs, headers: h},
                    );
                    const text = this.sc.decode(msg.data);
                    return (text ? JSON.parse(text) : undefined) as T;
                } catch (e) {
                    span.recordException(e as Error);
                    span.setStatus({code: SpanStatusCode.ERROR});
                    throw e;
                } finally {
                    span.end();
                }
            },
        );
    }

    registerReply(subject: string, queue: string, handler: ReplyHandler) {
        this.replyHandlers.set(subject, {queue, handler});
        if (this.nc) this.bindReply(subject, queue, handler);
    }

    private bindReply(subject: string, queue: string, handler: ReplyHandler) {
        if (!this.nc) return;
        const sub = this.nc.subscribe(subject, {queue});
        this.subs.push(sub);
        (async () => {
            for await (const m of sub) {
                const flowCtx = contextFromNatsHeaders(m.headers);
                const parent = this.extractTrace(m.headers);
                await otelContext.with(parent, () =>
                    tracer.startActiveSpan(
                        `NATS handle ${subject}`,
                        {
                            kind: SpanKind.SERVER,
                            attributes: {
                                'messaging.system': 'nats',
                                'messaging.destination': subject,
                                'flow.id': flowCtx.flowId,
                                'flow.step_id': flowCtx.stepId,
                                ...(flowCtx.parentStepId
                                    ? {'flow.parent_step_id': flowCtx.parentStepId}
                                    : {}),
                            },
                        },
                        (span) =>
                            runWithContext(flowCtx, async () => {
                                this.logger.log(`← handle ${subject}`, NatsService.name);
                                try {
                                    const text = this.sc.decode(m.data);
                                    const payload = text ? JSON.parse(text) : undefined;
                                    const result = await handler(payload);
                                    m.respond(this.sc.encode(JSON.stringify(result ?? null)));
                                } catch (e) {
                                    span.recordException(e as Error);
                                    span.setStatus({code: SpanStatusCode.ERROR});
                                    this.logger.error(
                                        `reply handler error on ${subject}`,
                                        e as Error,
                                    );
                                    const eh = natsHeaders();
                                    eh.set('x-error', '1');
                                    m.respond(
                                        this.sc.encode(JSON.stringify({error: String(e)})),
                                        {headers: eh},
                                    );
                                } finally {
                                    span.end();
                                }
                            }),
                    ),
                );
            }
        })().catch((e) => this.logger.error(`reply loop ${subject}`, e));
    }

    publish(subject: string, data: unknown) {
        if (!this.nc) {
            this.logger.warn(`publish dropped (no NATS): ${subject}`);
            return;
        }
        const flowCtx = forkContext();
        const h = contextToNatsHeaders(flowCtx);
        if (TRACE_EVENTS) this.injectTrace(h);
        this.nc.publish(subject, this.sc.encode(JSON.stringify(data ?? {})), {
            headers: h,
        });
    }

    registerEvent(subject: string, handler: EventHandler) {
        this.eventHandlers.push({subject, handler});
        if (this.nc) this.bindEvent(subject, handler);
    }

    private bindEvent(subject: string, handler: EventHandler) {
        if (!this.nc) return;
        const sub = this.nc.subscribe(subject);
        this.subs.push(sub);
        (async () => {
            for await (const m of sub) {
                const flowCtx = contextFromNatsHeaders(m.headers);
                let payload: unknown;
                try {
                    const text = this.sc.decode(m.data);
                    payload = text ? JSON.parse(text) : undefined;
                } catch {
                    payload = this.sc.decode(m.data);
                }
                const run = () =>
                    runWithContext(flowCtx, () => {
                        try {
                            handler(payload, m.subject);
                        } catch (e) {
                            this.logger.error(
                                `event handler error on ${m.subject}`,
                                e as Error,
                            );
                        }
                    });

                if (TRACE_EVENTS) {
                    const parent = this.extractTrace(m.headers);
                    otelContext.with(parent, () =>
                        tracer.startActiveSpan(
                            `NATS event ${m.subject}`,
                            {kind: SpanKind.CONSUMER},
                            (span) => {
                                try {
                                    run();
                                } finally {
                                    span.end();
                                }
                            },
                        ),
                    );
                } else {
                    run();
                }
            }
        })().catch((e) => this.logger.error(`event loop ${subject}`, e));
    }

    async onModuleDestroy() {
        for (const s of this.subs) await s.drain().catch(() => {
        });
        await this.nc?.drain().catch(() => {
        });
    }
}

@Module({
    providers: [NatsService],
    exports: [NatsService],
})
export class NatsModule {
}