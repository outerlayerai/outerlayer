"use client";

import { Box, Card, CardContent, Typography } from "@mui/material";

// ----------------------------------------------------------------------

type FooterSlot = {
  /** Helper/context text, left-aligned in the footer bar. */
  caption?: React.ReactNode;
  /** The primary action (typically the Save button), right-aligned. */
  action?: React.ReactNode;
};

type Props = {
  /**
   * Card heading. Omit it on single-card tabs, where the SettingsShell page
   * heading (and the nav item) already name the section — a card title there is
   * just a third synonym.
   */
  title?: string;
  description?: React.ReactNode;
  /**
   * Vercel-style footer bar: a neutral strip with a top hairline, caption left
   * and action right. Omit it for read-only sections — the card then ends at
   * its content with no strip.
   */
  footer?: FooterSlot;
  children: React.ReactNode;
};

/**
 * A settings card: h6 title + optional description above a bordered card (the
 * clean-room MuiCard supplies the 1px divider border + radius, no shadow). When
 * a `footer` is given the card gains the neutral action bar; without it the card
 * ends at its content.
 */
export function SettingsSection({ title, description, footer, children }: Props) {
  return (
    <Box sx={{ mb: 4 }}>
      {(title || description) && (
        <Box sx={{ mb: 2 }}>
          {title && <Typography variant="h6">{title}</Typography>}
          {description && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: title ? 0.5 : 0 }}>
              {description}
            </Typography>
          )}
        </Box>
      )}
      <Card>
        <CardContent>{children}</CardContent>
        {footer && (
          <Box
            data-testid="settings-section-footer"
            sx={{
              bgcolor: "background.neutral",
              borderTop: 1,
              borderColor: "divider",
              px: 3,
              py: 1.5,
              display: "flex",
              alignItems: "center",
              gap: 2,
              justifyContent: footer.caption ? "space-between" : "flex-end",
            }}
          >
            {footer.caption && (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {footer.caption}
              </Typography>
            )}
            {footer.action}
          </Box>
        )}
      </Card>
    </Box>
  );
}
