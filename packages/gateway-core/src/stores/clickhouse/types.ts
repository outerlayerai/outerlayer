export interface ClickHouseConfig {
  url: string;
  password: string;
}

export interface QueryOptions {
  settings?: Record<string, any>;
  format?: string;
  params?: QueryParams;
}

export type QueryParams = Record<string, string | number | boolean>;

export interface QueryResult<T = any> {
  data: T[];
  rows: number;
  statistics: {
    elapsed: number;
    rows_read: number;
    bytes_read: number;
  };
}

export interface ClickHouseError extends Error {
  code?: string;
  query?: string;
} 