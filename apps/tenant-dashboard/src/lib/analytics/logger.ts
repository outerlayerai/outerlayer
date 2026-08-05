/**
 * Analytics Logger
 *
 * Structured logging for analytics queries and operations.
 * Provides consistent log format for monitoring and debugging.
 * Exports are intentionally public for module consumers.
 */

/* eslint-disable import/no-unused-modules */

/**
 * Log levels supported by the analytics logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Base log entry structure.
 */
interface BaseLogEntry {
  service: 'analytics';
  timestamp: string;
  level: LogLevel;
}

/**
 * Log entry for query operations.
 */
interface QueryLogEntry extends BaseLogEntry {
  type: 'query';
  method: string;
  appId: string;
  durationMs: number;
  cached: boolean;
  params?: Record<string, unknown>;
}

/**
 * Log entry for errors.
 */
interface ErrorLogEntry extends BaseLogEntry {
  type: 'error';
  method: string;
  appId?: string;
  error: string;
  errorCode?: string;
  stack?: string;
}

/**
 * Log entry for health checks.
 */
interface HealthLogEntry extends BaseLogEntry {
  type: 'health';
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  error?: string;
}

type LogEntry = QueryLogEntry | ErrorLogEntry | HealthLogEntry;

/**
 * Logger configuration.
 */
interface LoggerConfig {
  /** Minimum log level to output */
  minLevel: LogLevel;
  /** Whether to include stack traces */
  includeStack: boolean;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Default logger configuration.
 */
const defaultConfig: LoggerConfig = {
  minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  includeStack: process.env.NODE_ENV !== 'production',
};

/**
 * Outputs a log entry if it meets the minimum level.
 */
function output(entry: LogEntry, config: LoggerConfig = defaultConfig): void {
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[config.minLevel]) {
    return;
  }

  const logFn = entry.level === 'error' ? console.error :
                entry.level === 'warn' ? console.warn :
                entry.level === 'debug' ? console.debug :
                console.log;

  logFn(JSON.stringify(entry));
}

/**
 * Analytics logger with structured logging methods.
 */
export const analyticsLogger = {
  /**
   * Logs a successful query.
   */
  query(
    method: string,
    appId: string,
    durationMs: number,
    cached: boolean,
    params?: Record<string, unknown>
  ): void {
    const entry: QueryLogEntry = {
      service: 'analytics',
      type: 'query',
      level: 'info',
      timestamp: new Date().toISOString(),
      method,
      appId,
      durationMs,
      cached,
      ...(params && { params }),
    };
    output(entry);
  },

  /**
   * Logs a slow query warning.
   */
  slowQuery(
    method: string,
    appId: string,
    durationMs: number,
    threshold: number = 1000
  ): void {
    if (durationMs > threshold) {
      const entry: QueryLogEntry = {
        service: 'analytics',
        type: 'query',
        level: 'warn',
        timestamp: new Date().toISOString(),
        method,
        appId,
        durationMs,
        cached: false,
        params: { slowQueryThreshold: threshold },
      };
      output(entry);
    }
  },

  /**
   * Logs an error.
   */
  error(
    method: string,
    error: Error | unknown,
    appId?: string
  ): void {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const entry: ErrorLogEntry = {
      service: 'analytics',
      type: 'error',
      level: 'error',
      timestamp: new Date().toISOString(),
      method,
      error: errorObj.message,
      ...(appId && { appId }),
      ...(defaultConfig.includeStack && errorObj.stack && { stack: errorObj.stack }),
      ...((error as { code?: string })?.code && { errorCode: (error as { code?: string }).code }),
    };
    output(entry);
  },

  /**
   * Logs a health check result.
   */
  health(
    status: 'healthy' | 'degraded' | 'unhealthy',
    latencyMs?: number,
    error?: string
  ): void {
    const entry: HealthLogEntry = {
      service: 'analytics',
      type: 'health',
      level: status === 'unhealthy' ? 'error' : status === 'degraded' ? 'warn' : 'info',
      timestamp: new Date().toISOString(),
      status,
      ...(latencyMs !== undefined && { latencyMs }),
      ...(error && { error }),
    };
    output(entry);
  },

  /**
   * Logs a debug message.
   */
  debug(message: string, data?: Record<string, unknown>): void {
    console.debug(JSON.stringify({
      service: 'analytics',
      level: 'debug',
      timestamp: new Date().toISOString(),
      message,
      ...data,
    }));
  },
};

/**
 * Timer utility for measuring operation duration.
 *
 * @example
 * ```typescript
 * const timer = createTimer();
 * await someOperation();
 * const durationMs = timer.elapsed();
 * ```
 */
export function createTimer(): { elapsed: () => number } {
  const start = performance.now();
  return {
    elapsed: () => Math.round(performance.now() - start),
  };
}

/**
 * Wraps a function with automatic timing and logging.
 *
 * @param method - Method name for logging
 * @param appId - Application ID for logging
 * @param fn - Async function to wrap
 * @param cached - Whether the result is from cache
 */
export async function withLogging<T>(
  method: string,
  appId: string,
  fn: () => Promise<T>,
  cached: boolean = false
): Promise<T> {
  const timer = createTimer();
  try {
    const result = await fn();
    const durationMs = timer.elapsed();
    analyticsLogger.query(method, appId, durationMs, cached);
    analyticsLogger.slowQuery(method, appId, durationMs);
    return result;
  } catch (error) {
    analyticsLogger.error(method, error, appId);
    throw error;
  }
}
