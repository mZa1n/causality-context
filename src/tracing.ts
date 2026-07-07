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
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-express': { enabled: false },
      '@opentelemetry/instrumentation-nestjs-core': { enabled: false },
      '@opentelemetry/instrumentation-ioredis': { enabled: false },
      '@opentelemetry/instrumentation-redis': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) =>
          (req.url ?? '').includes('/.well-known/'),
        requestHook: (span, req) => {
          if ('method' in req && 'url' in req) {
            const method = req.method ?? 'HTTP';
            const path = (req.url ?? '/').split('?')[0] || '/';
            span.updateName(`${method} ${path}`);
          }
        },
      },
    }),
    new PrismaInstrumentation({
      ignoreSpanTypes: [
        'prisma:engine:connection',
        'prisma:engine:serialize',
        'prisma:engine:response_json_serialize',
      ],
    }),
  ],
});
sdk.start();

const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
  ],
});
logs.setGlobalLoggerProvider(loggerProvider);

process.on('SIGTERM', () => {
  Promise.allSettled([sdk.shutdown(), loggerProvider.shutdown()]).finally(() =>
    process.exit(0),
  );
});
