"use client";

import { Box, Card, Grid, Paper, Skeleton, Stack } from "@mui/material";
import { visuallyHidden } from "@mui/utils";

// ----------------------------------------------------------------------

export type PageSkeletonVariant = "table-page" | "card-grid" | "two-pane" | "settings-form";

type Props = {
  /** Which destination layout to mirror. */
  variant: PageSkeletonVariant;
  /** Repeat count — table rows, grid cards, or form fields. Defaults per variant. */
  rows?: number;
  /** Render the title + actions block above the body. */
  header?: boolean;
  /**
   * Reserve space for a page-level action button in the header block. Pass
   * `false` on a page whose header carries no action — the placeholder would
   * otherwise promise a button that never arrives, reflowing the header on
   * exactly the axis this component exists to hold still.
   */
  headerAction?: boolean;
  /** Reserve the filter bar above a `table-page` body. */
  filterBar?: boolean;
  /** Reserve the pager row below a `table-page` body. */
  pager?: boolean;
  /**
   * A block to reserve between the header and the body — the chart, stat band,
   * or callout a page renders above its table. Supply `Skeleton`s at the
   * destination's real height; a block reserved at the wrong height reflows
   * just as a missing one does.
   *
   * Only what the server paints first belongs here. A block the client
   * toggles into place after hydration is not part of first paint, and no
   * server-rendered placeholder can hold room for it.
   */
  leading?: React.ReactNode;
  /** Override when one page carries more than one skeleton. */
  "data-testid"?: string;
};

/** Repeat counts that fill a first viewport without implying a page size. */
const DEFAULT_ROWS: Record<PageSkeletonVariant, number> = {
  "table-page": 8,
  "card-grid": 6,
  "two-pane": 8,
  "settings-form": 4,
};

const TABLE_COLUMNS = 5;
/**
 * The width of the file-tree rail this variant stands in for. It has to equal
 * the real rail exactly: a placeholder that is even a few pixels off shifts
 * both panes the moment data lands, which is the reflow the whole component
 * exists to prevent.
 */
const RAIL_WIDTH = 300;
const CARD_HEIGHT = 160;
/** Announced by assistive technology while the placeholder stands in. */
const LOADING_LABEL = "Loading";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Every landmark hangs off the root test id so two skeletons never collide. */
type BodyProps = { rows: number; testId: string };

function HeaderBlock({ testId, action }: { testId: string; action: boolean }) {
  return (
    <Stack
      direction="row"
      spacing={2}
      data-testid={`${testId}-header`}
      sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Skeleton variant="text" width={220} sx={{ fontSize: "2rem" }} />
        <Skeleton variant="text" width={320} sx={{ fontSize: "0.875rem" }} />
      </Box>
      {action && (
        <Skeleton
          variant="rounded"
          width={120}
          height={36}
          data-testid={`${testId}-header-action`}
        />
      )}
    </Stack>
  );
}

type TablePageBodyProps = BodyProps & { filterBar: boolean; pager: boolean };

function TablePageBody({ rows, testId, filterBar, pager }: TablePageBodyProps) {
  return (
    <>
      {filterBar && (
        <Skeleton
          variant="rounded"
          height={40}
          data-testid={`${testId}-filter-bar`}
          sx={{ mb: 2 }}
        />
      )}
      <Box
        data-testid={`${testId}-rows`}
        sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, overflow: "hidden" }}
      >
        <Stack
          direction="row"
          spacing={2}
          data-testid={`${testId}-head-row`}
          sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
        >
          {range(TABLE_COLUMNS).map((i) => (
            <Skeleton key={i} variant="text" sx={{ flex: 1, fontSize: "0.75rem" }} />
          ))}
        </Stack>
        {range(rows).map((row) => (
          <Stack
            key={row}
            direction="row"
            spacing={2}
            data-testid={`${testId}-row`}
            sx={{ px: 2, py: 1.5, alignItems: "center" }}
          >
            {range(TABLE_COLUMNS).map((col) => (
              <Skeleton key={col} variant="text" sx={{ flex: 1, fontSize: "1rem" }} />
            ))}
          </Stack>
        ))}
      </Box>
      {pager && (
        <Stack
          direction="row"
          spacing={2}
          data-testid={`${testId}-pager`}
          sx={{ alignItems: "center", justifyContent: "space-between", mt: 2 }}
        >
          <Skeleton variant="text" width={140} />
          <Skeleton variant="rounded" width={160} height={30} />
        </Stack>
      )}
    </>
  );
}

function CardGridBody({ rows, testId }: BodyProps) {
  return (
    <Grid container spacing={2} data-testid={`${testId}-grid`}>
      {range(rows).map((i) => (
        <Grid key={i} size={{ xs: 12, sm: 6, md: 4 }} data-testid={`${testId}-card`}>
          <Skeleton variant="rounded" height={CARD_HEIGHT} sx={{ borderRadius: 2 }} />
        </Grid>
      ))}
    </Grid>
  );
}

function TwoPaneBody({ rows, testId }: BodyProps) {
  return (
    <Paper
      variant="outlined"
      sx={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, overflow: "hidden" }}
    >
      <Box
        data-testid={`${testId}-rail`}
        sx={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          borderRight: "1px solid",
          borderColor: "divider",
          p: 1.5,
        }}
      >
        <Skeleton variant="rounded" height={36} sx={{ mb: 1.5 }} />
        <Stack spacing={1}>
          {range(rows).map((i) => (
            // Ragged widths read as a file tree rather than a stack of bars.
            <Skeleton key={i} variant="text" width={`${90 - (i % 4) * 12}%`} height={24} />
          ))}
        </Stack>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, p: 2 }}>
        <Skeleton variant="text" width="40%" sx={{ fontSize: "1.25rem", mb: 2 }} />
        <Skeleton variant="rounded" height={320} />
      </Box>
    </Paper>
  );
}

function SettingsFormBody({ rows, testId }: BodyProps) {
  return (
    <Card>
      <Stack spacing={3} data-testid={`${testId}-fields`} sx={{ p: 3 }}>
        {range(rows).map((i) => (
          <Box key={i} data-testid={`${testId}-field`}>
            <Skeleton variant="text" width={140} sx={{ fontSize: "0.875rem" }} />
            <Skeleton variant="rounded" height={40} />
          </Box>
        ))}
      </Stack>
      <Box
        sx={{
          bgcolor: "background.neutral",
          borderTop: 1,
          borderColor: "divider",
          px: 3,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <Skeleton variant="rounded" width={100} height={34} />
      </Box>
    </Card>
  );
}

/**
 * The loading placeholder for a page, shaped like the page it precedes: same
 * grid, same rail, roughly the right block heights. Mirroring the destination
 * is what keeps first paint from shifting once data arrives — a generic stack
 * of bars reflows the whole page.
 *
 * A full-page spinner is not an alternative here; it is reserved for auth and
 * boot, where there is no known destination shape.
 */
export function PageSkeleton({
  variant,
  rows,
  header = true,
  headerAction = true,
  filterBar = true,
  pager = true,
  leading,
  "data-testid": dataTestId = "page-skeleton",
}: Props) {
  const count = rows ?? DEFAULT_ROWS[variant];

  return (
    <Box
      data-testid={dataTestId}
      data-variant={variant}
      // A live region announces its CONTENT, and `status` is not named from
      // content — so the label has to be real text inside the region, not an
      // `aria-label`. The Skeletons themselves contribute none.
      //
      // `aria-busy` is deliberately absent: on a live region it means "defer
      // announcing until this clears", and this region never clears — it
      // unmounts wholesale once the data arrives, dropping the announcement.
      role="status"
      sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <Box component="span" sx={visuallyHidden}>
        {LOADING_LABEL}
      </Box>
      {header && <HeaderBlock testId={dataTestId} action={headerAction} />}
      {leading && <Box data-testid={`${dataTestId}-leading`}>{leading}</Box>}
      {variant === "table-page" && (
        <TablePageBody
          rows={count}
          testId={dataTestId}
          filterBar={filterBar}
          pager={pager}
        />
      )}
      {variant === "card-grid" && <CardGridBody rows={count} testId={dataTestId} />}
      {variant === "two-pane" && <TwoPaneBody rows={count} testId={dataTestId} />}
      {variant === "settings-form" && <SettingsFormBody rows={count} testId={dataTestId} />}
    </Box>
  );
}
