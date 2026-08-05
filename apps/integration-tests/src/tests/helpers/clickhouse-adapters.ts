import type { IClickHouseClient } from '../../../../gateway/src/jobs/storage-metering-handler';

export function asStorageMeteringClickHouseClient(
  client: IClickHouseClient,
): IClickHouseClient {
  return {
    query: async (params) => {
      const result = await client.query(params as never);
      return {
        json: async <T = unknown>() => {
          const rows = await result.json<T>();
          return Array.isArray(rows) ? rows : [];
        },
      };
    },
    close: () => client.close(),
  };
}
