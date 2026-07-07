import {
    Injectable,
    Logger,
    Module,
    OnModuleInit,
    OnModuleDestroy,
    Global,
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
            this.logger.log(
                { servers, event: 'Broker connection established' },
                'core.broker.middlewares.logger',
            );
            this.monitorConnection();
            this.attachAll();
        } catch (e) {
            this.logger.error(
                { servers, event: 'Broker connection failed' },
                e instanceof Error ? e.stack : String(e),
                'core.broker.middlewares.logger',
            );
            setTimeout(() => void this.initConnection(), 5000);
        }
    }

    private monitorConnection() {
        if (!this.nc) return;
        (async () => {
            for await (const s of this.nc!.status()) {
                this.logger.log(
                    { status: s.type, event: 'Broker connection status changed' },
                    'core.broker.middlewares.logger',
                );
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
                    this.logger.log(
                        { subject, event: 'Broker message publishing started' },
                        'core.broker.middlewares.logger',
                    ),
                );
                try {
                    const msg = await this.nc!.request(
                        subject,
                        this.sc.encode(JSON.stringify(data ?? {})),
                        {timeout: timeoutMs, headers: h},
                    );
                    this.logger.log(
                        { event: 'Broker message publishing finished' },
                        'core.broker.middlewares.logger',
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
                                this.logger.log(
                                    { subject, event: 'Broker message processing started' },
                                    'core.broker.middlewares.logger',
                                );
                                try {
                                    const text = this.sc.decode(m.data);
                                    const payload = text ? JSON.parse(text) : undefined;
                                    const result = await handler(payload);
                                    m.respond(this.sc.encode(JSON.stringify(result ?? null)));
                                    this.logger.log(
                                        { event: 'Broker message processing finished' },
                                        'core.broker.middlewares.logger',
                                    );
                                } catch (e) {
                                    span.recordException(e as Error);
                                    span.setStatus({code: SpanStatusCode.ERROR});
                                    this.logger.error(
                                        { subject, event: 'Broker message processing failed' },
                                        e instanceof Error ? e.stack : String(e),
                                        'core.broker.middlewares.logger',
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
        })().catch((e) =>
            this.logger.error(
                { subject, event: 'Broker reply loop failed' },
                e instanceof Error ? e.stack : String(e),
                'core.broker.middlewares.logger',
            ),
        );
    }

    publish(subject: string, data: unknown) {
        if (!this.nc) {
            this.logger.warn(
                { subject, event: 'Broker message publishing dropped' },
                'core.broker.middlewares.logger',
            );
            return;
        }
        const flowCtx = forkContext();
        const h = contextToNatsHeaders(flowCtx);
        if (TRACE_EVENTS) this.injectTrace(h);
        runWithContext(flowCtx, () => {
            this.logger.log(
                { subject, event: 'Broker message publishing started' },
                'core.broker.middlewares.logger',
            );

            this.nc!.publish(subject, this.sc.encode(JSON.stringify(data ?? {})), {
                headers: h,
            });

            this.logger.log(
                { event: 'Broker message publishing finished' },
                'core.broker.middlewares.logger',
            );
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
                this.logger.log(
                    { subject: m.subject, event: 'Broker event processing started' },
                    'core.broker.middlewares.logger',
                );
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
                            this.logger.log(
                                { event: 'Broker event processing finished' },
                                'core.broker.middlewares.logger',
                            );
                            handler(payload, m.subject);
                        } catch (e) {
                            this.logger.error(
                                { subject: m.subject, event: 'Broker event processing failed' },
                                e instanceof Error ? e.stack : String(e),
                                'core.broker.middlewares.logger',
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
        })().catch((e) =>
            this.logger.error(
                { subject, event: 'Broker event loop failed' },
                e instanceof Error ? e.stack : String(e),
                'core.broker.middlewares.logger',
            ),
        );
    }

    async onModuleDestroy() {
        for (const s of this.subs) await s.drain().catch(() => {
        });
        await this.nc?.drain().catch(() => {
        });
    }
}

@Global()
@Module({
    providers: [NatsService],
    exports: [NatsService],
})
export class NatsModule {
}