'use client';

/**
 * <AppBreadcrumb.OrgSelect> — the Org segment of the breadcrumb spine
 *.
 *
 * The org switcher already exists as `OrgSwitcher` (mounted in the header
 * today). Rather than re-implement its membership-list / create-org-dialog
 * logic, the breadcrumb wraps it — D2's "reuse if practical" applies here.
 * `OrgSwitcher` renders the org name + dropdown; the breadcrumb owns the
 * separators between segments, so this wrapper passes `showSeparator={false}`.
 *
 * Responsive: `OrgSwitcher` already ellipsises its own org-name label
 * (`maxWidth` + `textOverflow`), so the org segment never wraps. If a long org
 * name still overflows the available header width alongside the App/Env
 * segments, the breadcrumb root's horizontal-scroll container absorbs it —
 * the segment stays reachable, it is not clipped or hidden.
 */

import OrgSwitcher from '@/components/common/org-switcher';

export function OrgSelect() {
  return <OrgSwitcher showSeparator={false} />;
}
