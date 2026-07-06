import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export interface InitTracingOptions {
    serviceName?: string;
    endpoint?: string;
}

export function initTracing(opts: InitTracingOptions = {}): NodeSDK {
    const serviceName = opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
    const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
    const sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
        }),
        traceExporter: new OTLPTraceExporter({
            url: `${endpoint}/v1/traces`,
        }),
        instrumentations: [getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
            new PrismaInstrumentation(),
        ],
    });
    sdk.start();
    process.on('SIGTERM', () => {
        sdk.shutdown().finally(() => process.exit(0));
    });
    return sdk;
}