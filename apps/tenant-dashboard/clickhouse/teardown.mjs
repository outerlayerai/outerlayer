import { createClient } from '@clickhouse/client';

const client = createClient({
    host: 'http://localhost:8123'
});

await client.command({
    query: `
        DELETE FROM otel_traces WHERE TraceId IS NOT NULL
    `,
});

await client.command({
    query: `
        DROP TABLE otel_traces
    `,
});

console.log('clickhouse has been reset!')
