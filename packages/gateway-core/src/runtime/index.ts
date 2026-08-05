/**
 * `src/runtime/` — the DI seam for the gateway runtime decoupling.
 *
 * Core declares these interfaces; each entrypoint (Worker / Node) injects
 * concrete adapters via its own `buildGatewayContext`. See `gateway-context.ts`
 * for the container and the no-default-adapters rule.
 */
export type {
  ExecutionCtx,
  QueueProducer,
  QueueBatchProducer,
  QueueMessageSendRequest,
} from "./execution";
export type {
  BlobObject,
  BlobBucket,
  CronEvent,
} from "./bindings";
export type {
  GatewayContext,
  BuildGatewayContext,
  CacheL2Store,
  BillingService,
  LoggerFactory,
} from "./gateway-context";
