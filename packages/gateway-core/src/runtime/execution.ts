/**
 * Runtime-neutral primitives — the core's replacements for Cloudflare's
 * `@cloudflare/workers-types` shapes, so `gateway-core` carries no dependency on
 * the Workers type package. The real CF `ExecutionContext` / `Queue` are
 * structurally compatible with these, so a Worker composition root can pass its
 * native objects wherever these are expected.
 */

/**
 * The request-lifecycle capability every runtime provides: schedule background
 * work that outlives the response. On Workers this is the real
 * `ExecutionContext.waitUntil`; on Node it is a fire-and-forget shim.
 */
export interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/**
 * The single-message producer surface the gateway uses on a Cloudflare Queue
 * binding. Only `send` is consumed today; kept minimal on purpose.
 */
export interface QueueProducer<T = unknown> {
  send(message: T): Promise<void>;
}

/** Message envelope for {@link QueueBatchProducer.sendBatch} — mirrors
 *  Cloudflare Queues' `MessageSendRequest`. */
export interface QueueMessageSendRequest<T = unknown> {
  body: T;
  /** Defer first delivery by this many seconds (CF Queues cap: 43200). */
  delaySeconds?: number;
}

/**
 * Queue producer binding that also supports batched sends (Cloudflare Queues'
 * `sendBatch`, max 100 messages per call). Used by the usage-meter fan-out
 * (arch #4) so enqueuing N customers costs N/100 subrequests, not N.
 */
export interface QueueBatchProducer<T = unknown> extends QueueProducer<T> {
  sendBatch(messages: QueueMessageSendRequest<T>[]): Promise<void>;
}
