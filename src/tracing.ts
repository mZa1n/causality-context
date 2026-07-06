import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
    LoggerProvider,
    BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { logs } from '@opentelemetry/api-logs';
import { PrismaInstrumentation } from '@prisma/instrumentation';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
        getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-dns': { enabled: false },
            '@opentelemetry/instrumentation-express': { enabled: false },  // ← шелуха middleware
            '@opentelemetry/instrumentation-router': { enabled: false },   // ← router.patched спам
            '@opentelemetry/instrumentation-net': { enabled: false },
        }),
        new PrismaInstrumentation(),
    ],
});
sdk.start();
process.on('SIGTERM', () => {
    sdk.shutdown().finally(() => process.exit(0));
});