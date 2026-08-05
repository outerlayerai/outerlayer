// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, decomposeColor } from '@mui/material/styles';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';

import { createAppTheme, createPlatformAdminTheme } from '../theme/create-theme';
import { BRAND_PRIMARY_MAIN, PLATFORM_ADMIN_PRIMARY_MAIN } from '../theme/palette';
import { bgBlur } from '../theme/css';

// Rough perceived brightness (channel sum) — enough to assert a shade is
// darker/lighter than its main without pinning exact rgb strings.
function brightness(color: string): number {
  const [r, g, b] = decomposeColor(color).values;
  return r + g + b;
}

describe('createAppTheme', () => {
  const theme = createAppTheme();

  it('enables CSS theme variables with the class color-scheme selector', () => {
    expect(theme.colorSchemeSelector).toBe('class');
    expect(theme.vars.palette.primary.main).toMatch(/^var\(--mui-palette-primary-main/);
  });

  it('ships both light and dark color schemes', () => {
    expect(Object.keys(theme.colorSchemes ?? {}).sort()).toEqual(['dark', 'light']);
  });

  it('uses the brand-blue OKLCH ramp for the light primary', () => {
    const primary = theme.colorSchemes.light!.palette.primary;
    expect(primary.main).toBe(BRAND_PRIMARY_MAIN); // #2065D1
    expect(primary.light).toBe('#6499E6');
    expect(primary.dark).toBe('#1A55B8');
    expect(primary.lighter).toBe('#E9F0FC');
    expect(primary.darker).toBe('#143F86');
    expect(primary.contrastText).toBe('#FFFFFF');
  });

  it('lifts the dark primary to an AA-safe blue with ink contrast text', () => {
    const primary = theme.colorSchemes.dark!.palette.primary;
    expect(primary.main).toBe('#4C8DEE');
    expect(primary.contrastText).toBe('#0B1220');
  });

  it('aliases info to the brand blue in both schemes (never a second blue)', () => {
    expect(theme.colorSchemes.light!.palette.info.main).toBe(
      theme.colorSchemes.light!.palette.primary.main,
    );
    expect(theme.colorSchemes.dark!.palette.info.main).toBe(
      theme.colorSchemes.dark!.palette.primary.main,
    );
  });

  it('loads Geist for UI and JetBrains Mono for code/ids', () => {
    expect(theme.typography.fontFamily).toBe('Geist, sans-serif');
    expect(theme.typography.fontFamilyMonospace).toBe('JetBrains Mono, monospace');
  });

  it('uses the 14px-base type scale with de-capsed buttons', () => {
    expect(theme.typography.fontSize).toBe(14);
    expect(theme.typography.h1.fontSize).toBe('1.875rem');
    expect(theme.typography.h1.fontWeight).toBe(700);
    expect(theme.typography.button.textTransform).toBe('none');
    expect(theme.typography.fontWeightSemiBold).toBe(600);
  });

  it('sets an 8px base border radius', () => {
    expect(theme.shape.borderRadius).toBe(8);
  });

  it('flattens the shadow ladder to overlay/dialog only (no Material drop shadows)', () => {
    const shadows = theme.shadows;
    expect(shadows).toHaveLength(25);
    expect(shadows[0]).toBe('none');
    // Resting elevations collapse to one overlay value — no per-step Material ramp.
    expect(shadows[1]).toContain('4px 12px');
    expect(shadows[2]).toBe(shadows[1]);
    // The deep end is the dialog value.
    expect(shadows[8]).toContain('12px 32px');
    expect(shadows[24]).toBe(shadows[8]);
  });

  it('registers Tabs as scrollable-by-default merged with the underline override', () => {
    expect(theme.components?.MuiTabs?.defaultProps).toEqual({
      variant: 'scrollable',
      allowScrollButtonsMobile: true,
    });
    expect(theme.components?.MuiTabs?.styleOverrides?.root).toEqual({ minHeight: 40 });
  });

  it('disables Button elevation and kills the per-elevation Paper tint (dark-mode fix)', () => {
    // color defaults to "inherit" so a bare Button is ink by convention, not MUI
    // brand blue; disableElevation stays. Exact shape — a stray default fails here.
    expect(theme.components?.MuiButton?.defaultProps).toEqual({
      disableElevation: true,
      color: 'inherit',
    });
    expect(theme.components?.MuiPaper?.styleOverrides?.root).toEqual({ backgroundImage: 'none' });
  });

  it('derives dark-scheme compat shades that stay dark, not near-white', () => {
    const light = theme.colorSchemes.light!.palette;
    const dark = theme.colorSchemes.dark!.palette;

    // Light "lighter" is a pale tint; darker is a deep shade.
    expect(brightness(light.primary.lighter)).toBeGreaterThan(brightness(light.primary.main));
    expect(brightness(light.warning.lighter)).toBeGreaterThan(brightness(light.warning.main));

    // Dark "lighter" must be DARKER than its main — a light tint renders near-white
    // on a dark surface. This holds for the brand ramp and the derived secondary.
    expect(brightness(dark.primary.lighter)).toBeLessThan(brightness(dark.primary.main));
    expect(brightness(dark.warning.lighter)).toBeLessThan(brightness(dark.warning.main));
    expect(brightness(dark.secondary.lighter)).toBeLessThan(brightness(dark.secondary.main));

    // background.neutral is the spec's warm neutral per scheme.
    expect(light.background.neutral).toBe('#F4F4F2');
    expect(dark.background.neutral).toBe('#232320');
  });

  it('re-tunes status mains per scheme (light = MUI defaults, dark re-authored)', () => {
    expect(theme.colorSchemes.light!.palette.warning.main).toBe('#ED6C02');
    expect(theme.colorSchemes.light!.palette.success.main).toBe('#2E7D32');
    expect(theme.colorSchemes.dark!.palette.warning.main).toBe('#F0A94C');
    expect(theme.colorSchemes.dark!.palette.success.main).toBe('#66BB6A');
  });
});

describe('component style overrides', () => {
  const theme = createAppTheme();
  const components = theme.components!;
  // The callbacks only read `theme`, so `{ theme }` is a sufficient ownerState.
  const arg = { theme } as never;

  it('gives contained/inherit Buttons an ink CTA via the variants API', () => {
    // The default color is "inherit" AND the inherit+contained variant paints
    // ink — so a bare <Button variant="contained"> (no color prop) resolves to
    // the ink CTA. Both halves are pinned; break either and a plain CTA drifts
    // back to MUI brand blue.
    expect(theme.components?.MuiButton?.defaultProps?.color).toBe('inherit');
    const root = (components.MuiButton!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.borderRadius).toBe(8);
    expect(root.boxShadow).toBe('none');
    expect(root.variants).toHaveLength(1);
    expect(root.variants[0].props).toEqual({ variant: 'contained', color: 'inherit' });
    expect(root.variants[0].style.backgroundColor).toBe(theme.vars.palette.text.primary);
    expect(root.variants[0].style.color).toBe(theme.vars.palette.background.paper);

    const outlined = (components.MuiButton!.styleOverrides!.outlined as CallableFunction)(arg);
    expect(outlined.borderColor).toBe(theme.vars.palette.divider);
  });

  it('sizes medium/large buttons to the 40px control box with a 14px large label', () => {
    const overrides = components.MuiButton!.styleOverrides!;
    // 40px min-height on both medium and large so a CTA matches the input box;
    // large also drops to the 14px button label (not MUI's 15px sizeLarge).
    expect(overrides.sizeMedium).toEqual({ minHeight: 40 });
    expect(overrides.sizeLarge).toEqual({ minHeight: 40, fontSize: '0.875rem' });
    // Small is deliberately untouched (dense toolbars keep their compact height).
    expect(overrides.sizeSmall).toBeUndefined();
    // The 14px large label is exactly the base button type step — one size, not two.
    expect((overrides.sizeLarge as { fontSize: string }).fontSize).toBe(
      theme.typography.button.fontSize,
    );
  });

  it('renders the AppBar as quiet paper chrome with a hairline border', () => {
    const root = (components.MuiAppBar!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.backgroundColor).toBe(theme.vars.palette.background.paper);
    expect(root.color).toBe(theme.vars.palette.text.primary);
    expect(root.boxShadow).toBe('none');
    expect(root.borderBottom).toBe(`1px solid ${theme.vars.palette.divider}`);
  });

  it('renders the Drawer paper as opaque chrome (no elevation gradient)', () => {
    const paper = (components.MuiDrawer!.styleOverrides!.paper as CallableFunction)(arg);
    // Exact shape: the mobile nav drawer + notifications drawer read as solid
    // paper columns, never MUI's per-elevation background-image tint.
    expect(paper).toEqual({
      backgroundImage: 'none',
      backgroundColor: theme.vars.palette.background.paper,
    });
  });

  it('renders Cards flat and bordered with no dark overlay gradient', () => {
    const root = (components.MuiCard!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.border).toBe(`1px solid ${theme.vars.palette.divider}`);
    expect(root.boxShadow).toBe('none');
    expect(root.backgroundImage).toBe('none');
  });

  it('lifts the small input to the 40px control box via vertical padding', () => {
    // 10px top/bottom on the small input takes it from ~37px to ~40px so it
    // aligns with the 40px medium/large button box on a stacked column. Vertical
    // only — horizontal (and adornment) padding stays MUI's.
    const root = (components.MuiOutlinedInput!.styleOverrides!.root as CallableFunction)(arg);
    expect(root['&.MuiInputBase-sizeSmall .MuiOutlinedInput-input']).toEqual({
      paddingTop: 10,
      paddingBottom: 10,
    });
  });

  it('defaults the whole input family to the small (40px) control metric', () => {
    // TextField already defaults small; Select/Autocomplete/FormControl do not
    // inherit that, so pin them here — a no-size dropdown must not render at the
    // 56px medium and tower over the buttons beside it.
    expect(components.MuiTextField!.defaultProps!.size).toBe('small');
    expect(components.MuiSelect!.defaultProps!.size).toBe('small');
    expect(components.MuiAutocomplete!.defaultProps!.size).toBe('small');
    expect(components.MuiFormControl!.defaultProps!.size).toBe('small');
  });

  it('focuses the floating label to ink, matching the neutral-focus border', () => {
    const root = (components.MuiInputLabel!.styleOverrides!.root as CallableFunction)(arg);
    // Focused label is ink (not MUI's primary.main), so a blue label is never
    // paired with the ink focus border.
    expect(root['&.Mui-focused:not(.Mui-error)'].color).toBe(
      theme.vars.palette.text.primary,
    );
    // Error red must survive focus — the override deliberately excludes .Mui-error.
    expect(root['&.Mui-focused:not(.Mui-error)'].color).not.toBe(
      theme.vars.palette.error.main,
    );
  });

  it('focuses inputs with a neutral ink border, not a brand-blue ring', () => {
    const root = (components.MuiOutlinedInput!.styleOverrides!.root as CallableFunction)(arg);
    expect(root['& .MuiOutlinedInput-notchedOutline'].borderColor).toBe(
      theme.vars.palette.divider,
    );
    // The review deviation: focus is the ink step, never primary.main.
    expect(root['&.Mui-focused .MuiOutlinedInput-notchedOutline'].borderColor).toBe(
      theme.vars.palette.text.primary,
    );
    expect(root['& .MuiInputBase-input:focus-visible'].outline).toBe('none');
  });

  it('draws the Tab indicator and selected label in the brand blue', () => {
    const indicator = (components.MuiTabs!.styleOverrides!.indicator as CallableFunction)(arg);
    expect(indicator).toEqual({ height: 2, backgroundColor: theme.vars.palette.primary.main });

    const tab = (components.MuiTab!.styleOverrides!.root as CallableFunction)(arg);
    expect(tab.textTransform).toBe('none');
    expect(tab.color).toBe(theme.vars.palette.text.secondary);
    expect(tab['&.Mui-selected'].color).toBe(theme.vars.palette.primary.main);
  });

  it('renders the Tooltip as a solid ink chip', () => {
    const tooltip = (components.MuiTooltip!.styleOverrides!.tooltip as CallableFunction)(arg);
    expect(tooltip.backgroundColor).toBe(theme.vars.palette.text.primary);
    expect(tooltip.color).toBe(theme.vars.palette.background.paper);
    const tipArrow = (components.MuiTooltip!.styleOverrides!.arrow as CallableFunction)(arg);
    expect(tipArrow.color).toBe(theme.vars.palette.text.primary);
  });

  it('gives Menu/Popover a light overlay shadow with a dark-scheme swap', () => {
    for (const key of ['MuiMenu', 'MuiPopover'] as const) {
      const paper = (components[key]!.styleOverrides!.paper as CallableFunction)(arg);
      expect(paper.border).toBe(`1px solid ${theme.vars.palette.divider}`);
      expect(paper.backgroundImage).toBe('none');
      // Light resting shadow is the 4px overlay...
      expect(paper.boxShadow).toContain('4px 12px rgba(16,16,15,.10)');
      // ...and applyStyles('dark') injects the dark overlay under a scheme selector.
      expect(JSON.stringify(paper)).toContain('4px 12px rgba(0,0,0,.5)');
    }

    const item = (components.MuiMenuItem!.styleOverrides!.root as CallableFunction)(arg);
    expect(item['&.Mui-selected'].backgroundColor).toBe(theme.vars.palette.action.selected);
  });

  it('sizes the DialogTitle at the section-header ramp step, not the card-label h6', () => {
    const root = (components.MuiDialogTitle!.styleOverrides!.root as CallableFunction)(arg);
    // The default DialogTitle variant (h6) is remapped to card-label size in the
    // clean-room ramp; the dialog heading must read at the section-header (h5) step.
    expect(root.fontSize).toBe('1.0625rem');
    expect(root.fontSize).toBe(theme.typography.h5.fontSize);
    expect(root.fontSize).not.toBe(theme.typography.h6.fontSize);
    expect(root.fontWeight).toBe(600);
    expect(root.lineHeight).toBe(theme.typography.h5.lineHeight);
    expect(root.padding).toBe('20px 24px 8px');
  });

  it('joins the Dialog paper to the flat-overlay language without a doubled border ring', () => {
    // Exact shape: radius + killed elevation tint, and NO `border` — the dialog
    // shadow (dialogLight, "0 0 0 1px ...") already draws the hairline ring.
    expect(components.MuiDialog!.styleOverrides!.paper).toEqual({
      borderRadius: 10,
      backgroundImage: 'none',
    });
  });

  it('pads DialogContent and DialogActions on the 24px dialog gutter', () => {
    expect(components.MuiDialogContent!.styleOverrides!.root).toEqual({
      padding: '8px 24px 20px',
      // Re-asserted at equal-or-higher specificity than MUI's stock
      // `.MuiDialogTitle-root + .MuiDialogContent-root { padding-top: 0 }`,
      // which otherwise zeroes the gap and clips the floating label.
      '.MuiDialogTitle-root + &': { paddingTop: 8 },
    });
    expect(components.MuiDialogActions!.styleOverrides!.root).toEqual({
      padding: '12px 24px 20px',
    });
  });

  it('keeps the DialogContent top padding in the rendered DOM when a DialogTitle precedes it (sibling-selector specificity fix)', () => {
    render(
      <ThemeProvider theme={theme}>
        <Dialog open>
          <DialogTitle>Title</DialogTitle>
          <DialogContent data-testid="content">Body</DialogContent>
        </Dialog>
      </ThemeProvider>,
    );

    // Proves the fix survives the real cascade, not just the source object
    // asserted above: MUI's stock sibling-selector rule would otherwise win
    // on specificity and clip the shrunk floating label at the content box's
    // top edge.
    const content = screen.getByTestId('content');
    expect(getComputedStyle(content).paddingTop).toBe('8px');
  });

  it('joins the Autocomplete popup to the overlay language instead of a flat white sheet', () => {
    const paperOverride = (components.MuiAutocomplete!.styleOverrides!.paper as CallableFunction)(arg);
    expect(paperOverride.border).toBe(`1px solid ${theme.vars.palette.divider}`);
    expect(paperOverride.backgroundImage).toBe('none');
    // Same overlay contract as Menu/Popover above: light resting shadow...
    expect(paperOverride.boxShadow).toContain('4px 12px rgba(16,16,15,.10)');
    // ...and applyStyles('dark') injects the dark overlay under a scheme selector.
    expect(JSON.stringify(paperOverride)).toContain('4px 12px rgba(0,0,0,.5)');
    expect(components.MuiAutocomplete!.styleOverrides!.listbox).toEqual({ padding: 6 });
    const optionOverride = (components.MuiAutocomplete!.styleOverrides!.option as CallableFunction)(arg);
    expect(optionOverride['&[aria-selected="true"]'].backgroundColor).toBe(
      theme.vars.palette.action.selected,
    );

    // Render assertion: proves the paper actually resolves the overlay
    // shadow in the DOM. `border` is skipped here — jsdom's computed-style
    // engine cannot resolve a CSS custom property (`var(--mui-palette-divider)`)
    // inside a shorthand property, so `getComputedStyle(paper).border` never
    // parses even though the rule is present in the injected stylesheet
    // (confirmed by inspecting the raw `<style>` text during development).
    // `boxShadow` has no custom properties, so it resolves correctly and is
    // asserted against the real DOM here.
    render(
      <ThemeProvider theme={theme}>
        <Autocomplete open options={['a']} renderInput={(params) => <TextField {...params} />} />
      </ThemeProvider>,
    );
    const paper = document.querySelector('.MuiAutocomplete-paper') as HTMLElement;
    expect(paper).not.toBeNull();
    expect(getComputedStyle(paper).boxShadow).toBe(
      '0 0 0 1px rgba(16,16,15,.06),0 4px 12px rgba(16,16,15,.10)',
    );
  });

  it('sets Chips in the mono face on the neutral fill', () => {
    const root = (components.MuiChip!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.fontFamily).toBe(theme.typography.fontFamilyMonospace);
    expect(root.backgroundColor).toBe(theme.vars.palette.background.neutral);
  });

  it('colors Links the one blue with an accessible focus ring', () => {
    const root = (components.MuiLink!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.color).toBe(theme.vars.palette.primary.main);
    expect(root['&:focus-visible'].outline).toBe(
      `2px solid ${theme.vars.palette.primary.main}`,
    );
  });

  it('bands the TableCell header in the neutral surface', () => {
    const cellRoot = (components.MuiTableCell!.styleOverrides!.root as CallableFunction)(arg);
    expect(cellRoot.borderColor).toBe(theme.vars.palette.divider);
    const head = (components.MuiTableCell!.styleOverrides!.head as CallableFunction)(arg);
    expect(head.backgroundColor).toBe(theme.vars.palette.background.neutral);
    expect(head.color).toBe(theme.vars.palette.text.secondary);
  });

  it('installs one accessible focus ring globally via CssBaseline', () => {
    // CssBaseline receives the theme directly (not an ownerState wrapper).
    const base = (components.MuiCssBaseline!.styleOverrides as CallableFunction)(theme);
    expect(base.body.backgroundColor).toBe(theme.vars.palette.background.default);
    expect(base['*:focus-visible'].outline).toBe(
      `2px solid ${theme.vars.palette.primary.main}`,
    );
    expect(base['*'].scrollbarColor).toBe(
      `${theme.vars.palette.text.disabled} transparent`,
    );
  });

  it('checks the whole selection-control family on ink and quiets their resting state', () => {
    // The user ruling unified all controls on ink: Switch, Checkbox and Radio
    // all check text.primary, not brand blue. Semantic colors stay untouched.
    const switchBase = (components.MuiSwitch!.styleOverrides!.switchBase as CallableFunction)(arg);
    expect(switchBase['&.Mui-checked'].color).toBe(theme.vars.palette.text.primary);
    expect(switchBase['&.Mui-checked + .MuiSwitch-track']).toEqual({
      backgroundColor: theme.vars.palette.text.primary,
      opacity: 1,
    });
    const track = (components.MuiSwitch!.styleOverrides!.track as CallableFunction)(arg);
    expect(track).toEqual({
      backgroundColor: theme.vars.palette.text.disabled,
      opacity: 1,
    });

    // Recolor only — no geometry/size defaultProps that would ripple layout.
    expect(components.MuiSwitch!.defaultProps).toBeUndefined();

    const checkbox = (components.MuiCheckbox!.styleOverrides!.root as CallableFunction)(arg);
    expect(checkbox.color).toBe(theme.vars.palette.text.disabled);
    expect(checkbox['&.Mui-checked'].color).toBe(theme.vars.palette.text.primary);
    expect(checkbox['&.MuiCheckbox-indeterminate'].color).toBe(theme.vars.palette.text.primary);
    // A .Mui-error box draws its outline in error.main (RHF checkboxes add the
    // class on validation failure) — the required-checkbox red-feedback gap.
    expect(checkbox['&.Mui-error'].color).toBe(theme.vars.palette.error.main);

    const radio = (components.MuiRadio!.styleOverrides!.root as CallableFunction)(arg);
    expect(radio.color).toBe(theme.vars.palette.text.disabled);
    expect(radio['&.Mui-checked'].color).toBe(theme.vars.palette.text.primary);
  });

  it('retints Skeleton placeholders to the warm-neutral surface (recolor only)', () => {
    // Recolor-only by design: no borderRadius, which would override the circular
    // (50%) and text (fractional) variants' own radii.
    const root = (components.MuiSkeleton!.styleOverrides!.root as CallableFunction)(arg);
    expect(root).toEqual({
      backgroundColor: theme.vars.palette.background.neutral,
    });
  });

  it('renders the ToggleButton segmented control in the de-capsed Tab language', () => {
    const grouped = (components.MuiToggleButtonGroup!.styleOverrides!.grouped as CallableFunction)(arg);
    expect(grouped.borderColor).toBe(theme.vars.palette.divider);

    const root = (components.MuiToggleButton!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.textTransform).toBe('none');
    expect(root.fontWeight).toBe(500);
    expect(root.color).toBe(theme.vars.palette.text.secondary);
    expect(root.borderColor).toBe(theme.vars.palette.divider);
    expect(root['&.Mui-selected'].color).toBe(theme.vars.palette.primary.main);
    expect(root['&.Mui-selected'].backgroundColor).toBe(theme.vars.palette.action.selected);
    // Hover holds the selected fill — no stock primary-tint overwrite on hover.
    expect(root['&.Mui-selected']['&:hover'].backgroundColor).toBe(
      theme.vars.palette.action.selected,
    );
  });

  it('tokenizes standard + outlined Alerts through the clean-room severity ramp', () => {
    const root = (components.MuiAlert!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.borderRadius).toBe(8);
    expect(root.fontWeight).toBe(500);
    // 4 severities x { standard, outlined } — filled is untouched (absent in tree).
    expect(root.variants).toHaveLength(8);

    // Exact shape of the error entries pins the standard fill/ink and the
    // outlined border/ink — reverting either to stock MUI fails here.
    expect(root.variants[0]).toEqual({
      props: { variant: 'standard', severity: 'error' },
      style: {
        backgroundColor: theme.vars.palette.error.lighter,
        color: theme.vars.palette.error.dark,
      },
    });
    expect(root.variants[1]).toEqual({
      props: { variant: 'outlined', severity: 'error' },
      style: {
        color: theme.vars.palette.error.dark,
        borderColor: theme.vars.palette.error.main,
      },
    });

    // The info alias resolves to the brand-blue ramp (proves lighter/main exist
    // for info, which is the primary ramp rather than a MUI semantic default).
    const infoStandard = root.variants.find(
      (v: { props: { variant: string; severity: string } }) =>
        v.props.variant === 'standard' && v.props.severity === 'info',
    );
    expect(infoStandard.style.backgroundColor).toBe(theme.vars.palette.info.lighter);
    const infoOutlined = root.variants.find(
      (v: { props: { variant: string; severity: string } }) =>
        v.props.variant === 'outlined' && v.props.severity === 'info',
    );
    expect(infoOutlined.style.borderColor).toBe(theme.vars.palette.info.main);
  });

  it('recolors the Slider to the one blue with a palette-alpha focus halo', () => {
    const root = (components.MuiSlider!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.color).toBe(theme.vars.palette.primary.main);

    const rail = (components.MuiSlider!.styleOverrides!.rail as CallableFunction)(arg);
    expect(rail).toEqual({ backgroundColor: theme.vars.palette.divider, opacity: 1 });

    // No track border, so the primary fill reads as one solid bar.
    expect(components.MuiSlider!.styleOverrides!.track).toEqual({ border: 'none' });

    const thumb = (components.MuiSlider!.styleOverrides!.thumb as CallableFunction)(arg);
    expect(thumb['&:hover, &.Mui-focusVisible'].boxShadow).toBe(
      `0 0 0 6px ${theme.vars.palette.action.focus}`,
    );
  });

  it('flattens the Accordion family into a bordered panel with no gutter animation', () => {
    // disableGutters + zeroed elevation is what removes the margin-growth
    // animation and the drop shadow; both must be defaulted, not just styled.
    expect(components.MuiAccordion!.defaultProps).toEqual({
      elevation: 0,
      disableGutters: true,
    });

    const root = (components.MuiAccordion!.styleOverrides!.root as CallableFunction)(arg);
    expect(root.border).toBe(`1px solid ${theme.vars.palette.divider}`);
    expect(root.borderRadius).toBe(8);
    // Kill the stock ::before hairline and the expanded margin growth.
    expect(root['&:before']).toEqual({ display: 'none' });
    expect(root['&.Mui-expanded']).toEqual({ margin: 0 });

    // Summary height is pinned identical expanded/collapsed → no size animation.
    expect(components.MuiAccordionSummary!.styleOverrides!.root).toEqual({
      minHeight: 48,
      '&.Mui-expanded': { minHeight: 48 },
    });

    const details = (components.MuiAccordionDetails!.styleOverrides!.root as CallableFunction)(arg);
    expect(details.borderTop).toBe(`1px solid ${theme.vars.palette.divider}`);
    expect(details.padding).toBe(16);
  });
});

describe('createPlatformAdminTheme', () => {
  it('recolors only the primary and namespaces its vars off the mui prefix', () => {
    const admin = createPlatformAdminTheme();
    const base = createAppTheme();

    expect(admin.colorSchemes.light!.palette.primary.main).toBe(PLATFORM_ADMIN_PRIMARY_MAIN);
    expect(admin.colorSchemes.light!.palette.primary.main).not.toBe(
      base.colorSchemes.light!.palette.primary.main,
    );
    // Non-primary entries are untouched by the admin recolor.
    expect(admin.colorSchemes.light!.palette.warning.main).toBe(
      base.colorSchemes.light!.palette.warning.main,
    );
    expect(admin.vars.palette.primary.main).toMatch(/^var\(--admin-palette-primary-main/);
    expect(admin.colorSchemeSelector).toBe('class');
  });
});

describe('bgBlur', () => {
  it('produces a prefixed backdrop blur with an alpha-tinted fill', () => {
    expect(bgBlur({ color: '#FF0000', opacity: 0.8 })).toEqual({
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      backgroundColor: 'rgba(255, 0, 0, 0.8)',
    });
  });

  it('honours a caller-supplied opacity over the default', () => {
    const result = bgBlur({ color: '#000000', opacity: 0.48 });
    expect(result.backgroundColor).toBe('rgba(0, 0, 0, 0.48)');
    expect(result.backdropFilter).toBe('blur(6px)');
  });

  it('builds a scheme-switching rgba from a channel var (dark-mode aware)', () => {
    const result = bgBlur({
      colorChannel: 'var(--mui-palette-background-defaultChannel)',
      opacity: 0.8,
    });
    expect(result.backgroundColor).toBe(
      'rgba(var(--mui-palette-background-defaultChannel) / 0.8)',
    );
    expect(result.backdropFilter).toBe('blur(6px)');
  });
});
