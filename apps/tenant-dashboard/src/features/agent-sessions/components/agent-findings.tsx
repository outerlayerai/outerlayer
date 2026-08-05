/** Findings — team-scope deterministic findings + LLM-labeled error themes. */
import { Box, Card, CardContent, Chip, Divider, Typography } from "@mui/material";
import { EmptyState } from "@/components/empty-state";
import { LocalDate } from "@/components/local-date";
import { PageHeader } from "@/components/page-header";
import { Stack } from "./agent-ui";
import type { AgentFinding, AgentFindingsResponse } from "../types";
import { money, shortProject, SEVERITY_COLOR } from "./agent-format";

function FindingCard({ f }: { f: AgentFinding }) {
  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" spacing={1.5} alignItems="baseline">
          <Chip
            label={f.severity}
            size="small"
            sx={{ height: 20, fontSize: 10.5, textTransform: "uppercase", fontWeight: 600, color: SEVERITY_COLOR[f.severity] ?? "#5B6169", bgcolor: `${SEVERITY_COLOR[f.severity] ?? "#5B6169"}14` }}
          />
          <Typography sx={{ fontFamily: "monospace", fontSize: 15, fontWeight: 600 }}>{money(f.costUsd)}</Typography>
          <Typography sx={{ fontFamily: "monospace", fontSize: 12, color: "text.secondary" }}>
            {f.detectorId}
            {f.project ? ` · ${shortProject(f.project)}` : ""}
          </Typography>
        </Stack>
        <Typography sx={{ mt: 0.75 }}>{f.summary}</Typography>
        {f.suggestion && (
          <Typography sx={{ mt: 0.5, fontSize: 13, color: "text.secondary" }}>↳ {f.suggestion}</Typography>
        )}
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: "wrap" }}>
          {f.sessionIds.slice(0, 8).map((id) => (
            <Chip key={id} label={id.slice(0, 8)} size="small" variant="outlined" sx={{ height: 20, fontFamily: "monospace", fontSize: 11 }} />
          ))}
          {f.sessionCount > f.sessionIds.length && (
            <Typography sx={{ fontSize: 12, color: "text.secondary", alignSelf: "center" }}>
              +{f.sessionCount - f.sessionIds.length} more
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function AgentFindings({ data }: { data: AgentFindingsResponse }) {
  const isEmpty = data.themes.length === 0 && data.findings.length === 0;

  return (
    // No width or padding here: the layout frame owns the content column.
    <Box data-testid="findings-page">
      <PageHeader
        title="Findings"
        caption={
          <>
            Systemic patterns across the fleet — ranked by dollars, aggregated by pattern, never by person.
            {data.computedAt && (
              <>
                {" · Computed "}
                <LocalDate value={data.computedAt} format="numericDateTime" />
              </>
            )}
          </>
        }
      />

      {/* `computedAt` separates the two reasons this page can be empty: a
          detector pass that ran and flagged nothing, and no pass having run
          yet. One sentence covering both leaves the reader unable to tell
          whether the fleet is clean or the data is simply missing. */}
      {isEmpty &&
        (data.computedAt ? (
          <EmptyState
            title="No findings in this window"
            description="The detectors ran over this window and flagged nothing — no repeated failure patterns, no cost outliers."
          />
        ) : (
          <EmptyState
            title="No findings computed yet"
            description="Findings are produced by a detector pass over recorded sessions. Once the first pass completes for this window, systemic patterns appear here."
          />
        ))}

      {data.themes.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography sx={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".07em", color: "text.secondary", mb: 1 }}>
            Themes
          </Typography>
          <Stack spacing={1}>
            {data.themes.map((th) => (
              <Card key={th.id} variant="outlined" sx={{ borderLeft: `3px solid ${SEVERITY_COLOR[th.severity] ?? "#5B6169"}` }}>
                <CardContent sx={{ py: 1.25, "&:last-child": { pb: 1.25 } }}>
                  <Typography sx={{ fontWeight: 600 }}>{th.label}</Typography>
                  <Typography sx={{ fontSize: 13.5, color: "text.secondary", mt: 0.25 }}>{th.description}</Typography>
                </CardContent>
              </Card>
            ))}
          </Stack>
          <Divider sx={{ mt: 2 }} />
        </Box>
      )}

      {data.findings.length > 0 && (
        <Stack spacing={1.25}>
          {data.findings.map((f) => (
            <FindingCard key={f.id} f={f} />
          ))}
        </Stack>
      )}
    </Box>
  );
}
