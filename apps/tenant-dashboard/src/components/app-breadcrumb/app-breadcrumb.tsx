'use client';

/**
 * <AppBreadcrumb> — the three-segment navigation breadcrumb in the header.
 *
 * Renders `Org ▾ / App ▾ / Env ▾`. Each segment is an interactive selector,
 * not a static label: the Org segment switches org, the App
 * segment switches app, the Env segment switches the breadcrumb-selected
 * environment through `EnvContext`.
 *
 * This is a compound component (composition, no prop
 * drilling). The segments are exposed as `AppBreadcrumb.OrgSelect`,
 * `.AppSelect`, and `.EnvSelect` so a caller can recompose the breadcrumb; the
 * default body below assembles the standard order. Each segment consumes its
 * own context/hook directly — nothing is passed down as props.
 *
 * Responsive: the breadcrumb is a single-line row that flex-shrinks
 * inside the fixed-height header `Toolbar` (`flex: '1 1 auto'`, `minWidth: 0`).
 * It never wraps — wrapping in a fixed-height toolbar is exactly what made the
 * old env selector overlap the page heading at ≤768px / ≤390px. Instead the
 * row scrolls horizontally as a last resort and each segment's label is
 * ellipsised at a breakpoint-aware `maxWidth` (tight on mobile, generous on
 * desktop), so long org/app/env names truncate gracefully rather than push the
 * layout or wrap behind other elements. All three selectors stay reachable at
 * every breakpoint — they shrink and scroll, they are never hidden.
 */

import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { OrgSelect } from './org-select';
import { AppSelect } from './app-select';

/**
 * A `/` separator between two breadcrumb segments. The slash is the product's
 * own path vocabulary — org/app/env reads as a path in a prompts-as-code tool.
 */
function Separator() {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        mx: 0.75,
        flexShrink: 0,
        color: 'text.disabled',
        fontSize: '0.875rem',
        fontWeight: 400,
        lineHeight: 1,
      }}
    >
      /
    </Box>
  );
}

/**
 * The breadcrumb. Assembles the segments in `Org / App` order. The App
 * segment — and the separator leading to it — is only rendered inside an app
 * route (`[appName]` param present); on org-level pages it collapses to
 * just the org switcher with no dangling dots.
 *
 * Default-env-only posture: the multi-env UI is removed, so there is no Env
 * segment / switcher — the breadcrumb pins every app to its default env.
 */
function AppBreadcrumbRoot() {
  const { orgName, appName } = useParams();
  const inAppRoute = Boolean(appName);

  // On the org picker (/orgs) there is no active org, so the breadcrumb would
  // collapse to a lone org switcher rendering as a dead chevron-only button.
  // Render nothing there — the picker is its own org-selection surface.
  if (!orgName) return null;

  return (
    <Box
      component="nav"
      aria-label="App navigation breadcrumb"
      sx={{
        display: 'flex',
        alignItems: 'center',
        // Single line — no `flexWrap`. The header `Toolbar` is fixed-height, so
        // a wrapped second line overlaps the page heading (the ≤768px / ≤390px
        // bug this task fixes). The row shrinks to share header space...
        flex: '1 1 auto',
        minWidth: 0,
        flexWrap: 'nowrap',
        // ...and, only if the three truncated segments still don't fit, scrolls
        // horizontally so every selector stays reachable instead of clipping.
        overflowX: 'auto',
        overflowY: 'hidden',
        // Hide the scrollbar chrome — the row is still scrollable by
        // touch/trackpad; a visible bar inside the header looks broken.
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      {/* Each segment must not be shrunk to zero by the row's `minWidth: 0` —
          `flexShrink: 0` keeps every selector clickable; the label inside each
          one ellipsises instead. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <OrgSelect />
        {inAppRoute && (
          <>
            <Separator />
            <AppSelect />
          </>
        )}
      </Box>
    </Box>
  );
}

/**
 * Compound export. `AppBreadcrumb` renders the standard breadcrumb; the segment
 * sub-components are attached for callers that need to recompose it.
 */
export const AppBreadcrumb = Object.assign(AppBreadcrumbRoot, {
  OrgSelect,
  AppSelect,
});
