import Box from "@mui/material/Box";
import Stack, { StackProps } from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

// ----------------------------------------------------------------------

type EmptyContentProps = StackProps & {
  title?: string;
  imgUrl?: string;
  filled?: boolean;
  description?: string;
  action?: React.ReactNode;
};

// Neutral built-in illustration: a document outline with a folded corner,
// drawn from scratch and toned with `currentColor` so it tracks the color
// scheme. Callers that pass `imgUrl` get their own image instead.
function DefaultIllustration() {
  return (
    <Box sx={{ width: 1, maxWidth: 96, color: "text.disabled", lineHeight: 0 }}>
      <svg
        viewBox="0 0 48 48"
        width="100%"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M14 6h14l8 8v28a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        <path d="M28 6v8h8" />
        <line x1="19" y1="27" x2="29" y2="27" />
        <line x1="19" y1="33" x2="29" y2="33" />
      </svg>
    </Box>
  );
}

export default function EmptyContent({
  title,
  imgUrl,
  action,
  filled = true,
  description,
  sx,
  ...other
}: EmptyContentProps) {
  return (
    <Stack
      {...other}
      sx={[
        {
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          px: 3,
          height: 500,
        },
        filled && {
          borderRadius: 2,
          // sx palette shorthands resolve to `theme.vars.*` under the app's
          // cssVariables theme; a bare callback reading `theme.vars` would throw
          // when EmptyContent renders under a non-cssVariables theme (e.g. unit
          // tests that mount a consumer without the app ThemeProvider).
          bgcolor: "background.neutral",
          border: "1px dashed",
          borderColor: "divider",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {imgUrl ? (
        <Box
          component="img"
          alt=""
          src={imgUrl}
          sx={{ width: 1, maxWidth: 160 }}
        />
      ) : (
        <DefaultIllustration />
      )}

      {title && (
        <Typography
          variant="h6"
          component="span"
          sx={{ mt: 1, color: "text.disabled", textAlign: "center" }}
        >
          {title}
        </Typography>
      )}

      {description && (
        <Typography
          variant="caption"
          sx={{ mt: 1, color: "text.disabled", textAlign: "center" }}
        >
          {description}
        </Typography>
      )}

      {action}
    </Stack>
  );
}
