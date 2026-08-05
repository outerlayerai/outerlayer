"use client";

import { Button, Stack, Typography } from "@mui/material";

// ----------------------------------------------------------------------

type Props = {
  /**
   * Zero-based page index — the same basis as the `page` search param, so a
   * caller keeping paging in the URL passes it through untranslated.
   */
  page: number;
  pageSize: number;
  /** Total matching rows across every page, not the current page's length. */
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Plural noun for the no-results line. */
  itemNoun?: string;
  /** Override when one page carries more than one pager. */
  "data-testid"?: string;
};

/**
 * Pinned locale, not the ambient one. This component is `"use client"` but is
 * still server-rendered, and a bare `toLocaleString()` resolves to the server's
 * ICU locale during SSR and the browser's on the client — `1,234,567` against
 * `1.234.567` is a React hydration mismatch on any visitor whose locale differs
 * from the server's.
 */
const RANGE_FORMAT = new Intl.NumberFormat("en-US");

/**
 * The table footer pager: the current range on the left, Prev / position /
 * Next on the right. Presentational — the caller owns where the page index
 * lives (the URL, for a shareable view) and how it changes.
 *
 * Only the range is thousands-separated. The position readout keeps raw digits
 * on purpose — see the comment at its render site before "fixing" the
 * asymmetry.
 */
export function TablePager({
  page,
  pageSize,
  total,
  onPrev,
  onNext,
  itemNoun = "items",
  "data-testid": dataTestId = "table-pager",
}: Props) {
  const pageCount = Math.ceil(total / pageSize);
  // A `page` past the end is reachable: it survives in a shareable URL while
  // the result set behind it shrinks. The readout clamps to the last real page
  // so it can never claim rows that do not exist, while the buttons stay keyed
  // to the raw `page` — Prev has to remain live to get back to real data, and
  // correcting the caller's state from render is not this component's job.
  const displayedPage = pageCount > 0 ? Math.min(page, pageCount - 1) : 0;
  const rangeStart = displayedPage * pageSize + 1;
  const rangeEnd = Math.min((displayedPage + 1) * pageSize, total);

  return (
    <Stack
      direction="row"
      spacing={2}
      data-testid={dataTestId}
      sx={{ alignItems: "center", justifyContent: "space-between", mt: 2 }}
    >
      <Typography
        variant="caption"
        data-testid={`${dataTestId}-range`}
        sx={{ color: "text.secondary" }}
      >
        {total === 0
          ? `no ${itemNoun} match`
          : `${RANGE_FORMAT.format(rangeStart)}–${RANGE_FORMAT.format(rangeEnd)} of ${RANGE_FORMAT.format(total)}`}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        {/* The click event is swallowed rather than forwarded: the handlers are
            declared zero-argument, so a caller may pass a function whose first
            parameter means something else entirely. */}
        <Button
          size="small"
          disabled={page === 0}
          onClick={() => onPrev()}
          sx={{ textTransform: "none" }}
        >
          &larr; Prev
        </Button>
        {/* The position keeps raw digits while the range is separated. This is
            deliberate, not an oversight: it is a compact monospace readout
            wedged between two buttons, where separators cost width and make it
            jitter as the page changes. */}
        <Typography
          variant="caption"
          data-testid={`${dataTestId}-position`}
          sx={{ fontFamily: "monospace", color: "text.secondary" }}
        >
          {pageCount ? displayedPage + 1 : 0} / {pageCount}
        </Typography>
        <Button
          size="small"
          disabled={page + 1 >= pageCount}
          onClick={() => onNext()}
          sx={{ textTransform: "none" }}
        >
          Next &rarr;
        </Button>
      </Stack>
    </Stack>
  );
}
