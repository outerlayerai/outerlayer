import { createClient, DataFormat } from "@clickhouse/client-web";

export interface ClickHouseConfig {
  url: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  username?: string;
  password: string;
}

export interface QueryResult<T = any> {
  data: T[];
}

export interface QueryOptions {
  queryParams?: Record<string, any>;
}

export const createClickHouseStore = (config: ClickHouseConfig) => {
  const client = createClient({
    url: config.url,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
  });

  const query = async <T = any>(query: string, options?: QueryOptions): Promise<QueryResult<T>> => {
    const result = await client.query({
      query,
      format: 'JSONEachRow' as DataFormat,
      query_params: options?.queryParams,
    });

    const data = await result.json();
    return { 
      data: (Array.isArray(data) ? data : data.data || []) as T[] 
    };
  };

  return { query };
}; 