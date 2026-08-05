"use client";

/**
 * Empty / edge states for the Context surface. Each state is a distinct branch
 * — the caller (`context-view`) picks exactly one, they are never shown
 * together:
 *   - no git connection      → route the user to connect a repo
 *   - connected, never synced → "set up context" + Resync
 *   - connected, empty tree   → "no context yet" + docs
 *
 * The first two are the whole page body and use the shared `EmptyState` card.
 * The third renders INSIDE the editor pane of the two-pane shell, where that
 * card would draw a box inside the pane's own outlined box — so it keeps the
 * local bare-centered treatment below. The difference is placement, not
 * importance; the copy and CTA vocabulary are identical across all three.
 *
 * The mirror-stale banner deliberately lives in `context-view` as an inline
 * Alert instead: it reports on content that loaded fine, so replacing a working
 * editor with a card would overstate it.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { EmptyState } from "@/components/empty-state";

/** Default docs target for the "set up context" CTA; overridable so the page owns the exact URL. */
const CONTEXT_DOCS_URL = "https://docs.agentmark.co/context";

/**
 * The in-pane treatment: bare and centered, no card. Used only where the state
 * renders inside the editor pane, which already has its own outline.
 */
function InPaneEmptyState({
  title,
  body,
  primary,
  secondary,
}: {
  title: string;
  body: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <Box sx={{ display: "flex", height: 1, minHeight: 420, alignItems: "center", justifyContent: "center", p: 3 }}>
      <Stack spacing={2} sx={{ maxWidth: 420, alignItems: "center", textAlign: "center" }}>
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {body}
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", pt: 1 }}>
          {primary}
          {secondary}
        </Stack>
      </Stack>
    </Box>
  );
}

/**
 * Resync trigger. The page owns the `resyncContextAction` call (gated
 * `context.read`) and passes it in as `onResync`, so this stays a pure
 * component; disabled while a resync is in flight.
 */
export function ResyncButton({
  onResync,
  resyncing,
}: {
  onResync?: () => void;
  resyncing?: boolean;
}) {
  const { t } = useTranslate();
  return (
    <Button
      variant="outlined"
      color="inherit"
      onClick={onResync}
      loading={resyncing}
      // Independent of the busy state: with no handler wired there is nothing
      // to trigger, and `loading` alone would leave the button live.
      disabled={!onResync}
      startIcon={<Iconify icon="mdi:refresh" />}
      data-testid="context-resync-button"
    >
      {resyncing ? t("dashboard.context.empty.resyncing") : t("dashboard.context.empty.resync")}
    </Button>
  );
}

export function NoGitConnectionState({ connectHref }: { connectHref: string }) {
  const { t } = useTranslate();
  return (
    <EmptyState
      title={t("dashboard.context.empty.noConnectionTitle")}
      description={t("dashboard.context.empty.noConnectionBody")}
      action={
        <Button variant="contained" href={connectHref} startIcon={<Iconify icon="mdi:link-variant" />}>
          {t("dashboard.context.empty.noConnectionCta")}
        </Button>
      }
    />
  );
}

export function NeverSyncedState({
  docsHref = CONTEXT_DOCS_URL,
  onResync,
  resyncing,
}: {
  docsHref?: string;
  onResync?: () => void;
  resyncing?: boolean;
}) {
  const { t } = useTranslate();
  return (
    <EmptyState
      title={t("dashboard.context.empty.neverSyncedTitle")}
      description={t("dashboard.context.empty.neverSyncedBody")}
      action={
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Button variant="contained" href={docsHref} target="_blank" rel="noopener" startIcon={<Iconify icon="mdi:book-open-variant" />}>
            {t("dashboard.context.empty.neverSyncedCta")}
          </Button>
          <ResyncButton onResync={onResync} resyncing={resyncing} />
        </Stack>
      }
    />
  );
}

export function NoContextFoundState({ docsHref = CONTEXT_DOCS_URL }: { docsHref?: string }) {
  const { t } = useTranslate();
  return (
    <InPaneEmptyState
      title={t("dashboard.context.empty.noContextTitle")}
      body={t("dashboard.context.empty.noContextBody")}
      primary={
        <Button variant="contained" href={docsHref} target="_blank" rel="noopener" startIcon={<Iconify icon="mdi:book-open-variant" />}>
          {t("dashboard.context.empty.noContextCta")}
        </Button>
      }
    />
  );
}

