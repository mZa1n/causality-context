export class LogTransport {
    private queue: string[] = [];
    private timer: NodeJS.Timeout;
    private readonly url: string;
    private readonly maxBatch = 100;

    constructor() {
        const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
        this.url = `${base.replace(/\/$/, '')}/v1/logs`;
        this.timer = setInterval(() => void this.flush(), 2000);
        this.timer.unref();
    }

    enqueue(line: string) {
        this.queue.push(line);
        if (this.queue.length >= this.maxBatch) void this.flush();
    }

    private async flush() {
        if (this.queue.length === 0) return;
        const batch = this.queue;
        this.queue = [];
        try {
            await fetch(this.url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: batch.join('\n'),
            });
        } catch {}
    }

    async shutdown() {
        clearInterval(this.timer);
        await this.flush();
    }
}
