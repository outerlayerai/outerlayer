"use client";

/**
 * A timestamp in the visitor's own timezone.
 *
 * The server and the browser sit in different timezones and locales, so a date
 * rendered in both places hydrates into a mismatch — see utils/format-date.
 * This renders nothing on the server and fills in after mount, which makes the
 * visitor's ambient timezone the only one that ever formats a date.
 *
 * The pre-mount placeholder reserves the width the value is expected to
 * occupy, which keeps the fill-in from reflowing its line in the common case.
 * It is a bound, not a guarantee: the budgets are sized to the widest en-US
 * rendering, so a shorter value still narrows the box on arrival and a locale
 * with longer month names can still overflow it.
 */

import { useMounted } from "@/hooks/use-mounted";
import {
  formatLocalDate,
  RESERVED_CH,
  type LocalDateFormat,
  type LocalDateValue,
} from "@/utils/format-date";

export function LocalDate({
  value,
  format = "dateTime",
  absent = "—",
}: {
  value: LocalDateValue;
  format?: LocalDateFormat;
  /** Shown once mounted when the value is missing or unparseable. */
  absent?: string;
}) {
  const { isMounted } = useMounted();

  if (!isMounted) {
    return (
      <span
        aria-hidden="true"
        data-testid="local-date-placeholder"
        style={{ display: "inline-block", minWidth: `${RESERVED_CH[format]}ch` }}
      />
    );
  }

  return <>{formatLocalDate(value, format) ?? absent}</>;
}
