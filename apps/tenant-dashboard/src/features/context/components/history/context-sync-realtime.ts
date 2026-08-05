/**
 * Realtime seam for the Context › History panel. `context_sync_event` is in the
 * `supabase_realtime` publication, so a new sync attempt (link/push/resync)
 * broadcasts an INSERT; this wires that INSERT to a refetch — the same shape the
 * notifications popover uses.
 *
 * The channel topic is caller-supplied and MUST be unique per subscription: the
 * frontend Supabase client is a process-wide singleton and realtime-js
 * (>=2.11.10) dedupes channels by topic, so two co-mounted subscribers on a
 * fixed name collapse onto one already-joined channel and the second
 * `.subscribe()` throws. Callers derive the topic from `useId()`.
 */
import { createSupabaseFontendClient } from "@/lib/adapters/supabase-frontend-client";

interface SubscribeContextSyncEventsArgs {
  appId: string;
  /** Unique per subscription (useId-derived) — see the realtime-js dedup note above. */
  topic: string;
  /** Invoked on every INSERT for this app (and once the channel is SUBSCRIBED). */
  onChange: () => void;
}

/** Subscribes to `context_sync_event` inserts for one app; returns an unsubscribe. */
export function subscribeContextSyncEvents({
  appId,
  topic,
  onChange,
}: SubscribeContextSyncEventsArgs): () => void {
  const supabase = createSupabaseFontendClient();
  const channel = supabase
    .channel(topic)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "context_sync_event",
        filter: `app_id=eq.${appId}`,
      },
      () => onChange(),
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") onChange();
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
