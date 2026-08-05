/**
 * Runtime-neutral structural shapes for the Cloudflare Worker *bindings* the
 * `Env` object carries — the blob bucket and the cron event. Core types the
 * binding fields against these minimal domain surfaces so it never imports
 * `@cloudflare/workers-types`, and the real CF objects — being structurally
 * wider — pass wherever these are expected.
 *
 * Only the composition roots + Cloudflare adapters read these fields at all
 * (business logic reaches capabilities through `gtx`); those CF-side sites keep
 * the exact CF type via a local cast when they need it. Everything here is
 * declared with method shorthand so parameter checks stay bivariant.
 */

/** A stored blob's read side — only `arrayBuffer()` is consumed (server-side
 * blob rehydration). */
export interface BlobObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The blob store backing `TRACE_BLOBS` (oversized span payloads lifted at
 * ingest): `put`/`get`. `get` resolves `null` when the object is absent. */
export interface BlobBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<BlobObject | null>;
}

/** The cron trigger the scheduled entry fires with. `cron` tags the fired
 * schedule; `scheduledTime` is the epoch-ms fire time. (The CF
 * `ScheduledController` is structurally wider.) */
export interface CronEvent {
  cron: string;
  scheduledTime: number;
  /** Opt this fire out of automatic retries. Present on the CF
   * `ScheduledController`; optional here since core never calls it. */
  noRetry?(): void;
}
