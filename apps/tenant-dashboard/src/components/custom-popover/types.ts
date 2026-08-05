import { PopoverProps } from '@mui/material/Popover';

// ----------------------------------------------------------------------

export type MenuPopoverArrowValue =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'left-top'
  | 'left-center'
  | 'left-bottom'
  | 'right-top'
  | 'right-center'
  | 'right-bottom';

export interface MenuPopoverProps extends Omit<PopoverProps, 'open'> {
  /**
   * The anchor element (or `null` when closed). Doubles as `anchorEl` and gates
   * rendering via `Boolean(open)`, matching the `usePopover` return shape.
   */
  open: HTMLElement | null;
  arrow?: MenuPopoverArrowValue;
  /**
   * When set, the pointer arrow (beak) back at the trigger is not rendered at
   * all. Use for popovers anchored flush to their trigger where a beak reads as
   * noise (e.g. the account menu).
   */
  hiddenArrow?: boolean;
  /**
   * By default children are wrapped in a `<MenuList>` so `<MenuItem>`s resolve
   * the `MenuListContext` that MUI v9 requires (it throws without it). Set this
   * for popovers whose content is a form/custom layout — not menu items — or
   * that already render their own `<MenuList>`.
   */
  disableList?: boolean;
}
