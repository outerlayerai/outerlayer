"use client";

/**
 * The Overview's worklist: never-used artifacts and inventory issues, each
 * with a deep link into the Files view. An empty list is the HEALTHY outcome
 * and says so — silence would read as "not loaded".
 */
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslate } from "@outerlayer/locales";
import type { ContextOverviewResponse } from "../../types";
import { attentionItems, type AttentionItem } from "./context-overview-model";

function itemDescription(
  t: (key: string, opts?: Record<string, unknown>) => string,
  item: AttentionItem,
  lookbackDays: number,
): string {
  if (item.kind === "skill-never") {
    return t("dashboard.context.overview.attentionNeverSkill", { days: lookbackDays });
  }
  if (item.kind === "server-never") {
    return t("dashboard.context.overview.attentionNeverServer", { days: lookbackDays });
  }
  return t(`dashboard.context.overview.attentionIssue.${item.issue!}`);
}

export function NeedsAttentionRail({
  response,
  onOpenFile,
}: {
  response: ContextOverviewResponse;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslate();
  const items = attentionItems(response);

  return (
    <Paper variant="outlined" data-testid="overview-attention-rail">
      <Typography
        variant="subtitle2"
        sx={{ px: 2, py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}
      >
        {t("dashboard.context.overview.attentionTitle")}
      </Typography>
      {items.length === 0 ? (
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", px: 2, py: 1.5 }}>
          {t("dashboard.context.overview.attentionEmpty")}
        </Typography>
      ) : (
        <Stack divider={<span />} data-testid="overview-attention-items">
          {items.map((item) => (
            <Stack
              key={`${item.kind}:${item.name}:${item.issue ?? ""}`}
              spacing={0.25}
              sx={{ px: 2, py: 1.25, borderBottom: "1px solid", borderColor: "divider", "&:last-of-type": { borderBottom: 0 } }}
            >
              <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                {item.name}
              </Typography>
              <Typography
                variant="caption"
                sx={{ color: item.kind === "issue" ? "warning.main" : "error.main" }}
              >
                {itemDescription(t, item, response.lookbackDays)}
              </Typography>
              {item.filePath !== null && (
                <Link
                  component="button"
                  type="button"
                  variant="caption"
                  onClick={() => onOpenFile(item.filePath!)}
                  sx={{ alignSelf: "flex-start", fontWeight: 600 }}
                  data-testid={`overview-attention-open-${item.name}`}
                >
                  {t("dashboard.context.overview.attentionOpen")}
                </Link>
              )}
            </Stack>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
