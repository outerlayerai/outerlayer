import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { useResponsive } from "../../hooks/use-responsive";
import Logo from '@/components/logo';
import { useTranslate } from "@outerlayer/locales";

// ----------------------------------------------------------------------

type TranslationKey = string;

type Props = {
  title?: TranslationKey;
  children: React.ReactNode;
};

// The marker: a highlighter swipe over the words that carry evidence.
// Pinned hex, never theme vars: a highlighter is a physical object and must
// not re-ink in dark mode (theme ramps flip and turn it gold-on-gold, ~1.2:1
// contrast). Near-black ink on the warm marker clears 8:1 in both schemes.
// Mirrors .mark-ol in apps/outerlayer-site.
const markerSx = {
  bgcolor: "#FF9800",
  color: "#1A1A18",
  px: "0.14em",
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
} as const;

export default function AuthClassicLayout({ children, title }: Props) {
  const mdUp = useResponsive("up", "md");
  const { t } = useTranslate();

  const renderLogo = (
    <Logo
      sx={{
        zIndex: 9,
        position: "absolute",
        m: { xs: 2, md: 5 },
      }}
    />
  );

  const renderContent = (
    <Stack
      sx={{
        width: 1,
        mx: "auto",
        maxWidth: 480,
        px: { xs: 2, md: 8 },
        pt: { xs: 15, md: 20 },
        pb: { xs: 15, md: 0 },
      }}
    >
      {children}
    </Stack>
  );

  // Eyebrow: same grammar as the marketing site hero (mono, uppercase,
  // tracked, functional blue).
  const renderKicker = (
    <Typography
      variant="body2"
      sx={{
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "primary.main",
      }}
    >
      Open source · agentic engineering
    </Typography>
  );

  // The category claim (or a page-specific override, e.g. accept-invite).
  // component="p" on purpose: the document heading belongs to the form panel.
  const renderHeadline = (
    <Typography variant="h3" component="p">
      {title ? (
        t(title)
      ) : (
        <>
          The{" "}
          <Box component="span" sx={markerSx}>
            evidence layer
          </Box>{" "}
          for coding agents.
        </>
      )}
    </Typography>
  );

  // The three questions the person logging in is on the hook for, then the
  // mechanism that answers them.
  const renderSubhead = (
    <Stack spacing={0.5}>
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        Shipping faster? Worth the spend? Ready for more autonomy?
      </Typography>
      <Typography variant="body1" sx={{ color: "text.secondary" }}>
        Outerlayer answers from evidence: every session tied to how its code
        held up.
      </Typography>
    </Stack>
  );

  // The proof artifact: the evidence loop in four lines. The fleet's week
  // distilled to what needs a human, the top pattern worth attention, its
  // cost in outcomes, and the measured fix. Sample figures mirror our own
  // fleet, never customer data.
  const artifactLineSx = {
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 1.9,
    whiteSpace: "pre",
  } as const;

  const renderArtifact = (
    <Stack spacing={1.5}>
      <Box
        sx={{
          borderRadius: 1.5,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography
            sx={{
              fontFamily: "monospace",
              fontSize: 12,
              color: "text.secondary",
            }}
          >
            ▣ outerlayer
          </Typography>
        </Box>

        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography component="div" sx={artifactLineSx}>
            <Box component="span" sx={{ color: "text.secondary" }}>
              416 sessions this week ·{" "}
            </Box>
            <Box component="span" sx={{ fontWeight: 600 }}>
              3 worth your attention
            </Box>
          </Typography>
          <Typography component="div" sx={artifactLineSx}>
            <Box component="span" sx={{ color: "primary.main" }}>
              {"#1 "}
            </Box>
            agents pass --no-verify when pre-push fails
          </Typography>
          <Typography
            component="div"
            sx={{ ...artifactLineSx, color: "text.secondary" }}
          >
            {"   41 sessions · $184 rework · 2 reverts"}
          </Typography>
          <Typography
            component="div"
            sx={{ ...artifactLineSx, color: "text.secondary" }}
          >
            {"   fix shipped to CLAUDE.md · "}
            <Box
              component="span"
              sx={{ color: "success.main", fontWeight: 600 }}
            >
              repeat rate 31% → 4%
            </Box>
          </Typography>
        </Box>
      </Box>

      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "text.secondary",
        }}
      >
        No per-developer leaderboards. Ever.
      </Typography>
    </Stack>
  );

  const renderSection = (
    <Stack
      sx={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        px: 3,
        py: 10,
        bgcolor: "background.neutral"
      }}>
      <Stack spacing={5} sx={{ width: 1, maxWidth: 480 }}>
        <Stack spacing={2.5}>
          {renderKicker}
          {renderHeadline}
          {renderSubhead}
        </Stack>

        {renderArtifact}
      </Stack>
    </Stack>
  );

  return (
    <Stack
      component="main"
      direction="row"
      sx={{
        minHeight: "100vh",
      }}
    >
      {renderLogo}

      {mdUp && renderSection}

      {renderContent}
    </Stack>
  );
}
