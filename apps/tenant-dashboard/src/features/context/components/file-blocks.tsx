"use client";

/**
 * File-level display blocks shared by the always-on editor surface: the MCP
 * server summary and the oversize notice. Frontmatter is edited inline as raw
 * bytes on the editor surface, so there is no separate frontmatter card here.
 */
import { useMemo } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslate } from "@outerlayer/locales";

export function OversizeNotice({ providerFileUrl }: { providerFileUrl?: string }) {
  const { t } = useTranslate();
  return (
    <Alert severity="info">
      {t("dashboard.context.fileBlocks.oversizeTooLarge")}{" "}
      {providerFileUrl ? (
        <Link href={providerFileUrl} target="_blank" rel="noopener">
          {t("dashboard.context.fileBlocks.oversizeViewProvider")}
        </Link>
      ) : (
        t("dashboard.context.fileBlocks.oversizeOpenRepo")
      )}
    </Alert>
  );
}

/** Structured summary of an mcp.json — server list above the raw JSON editor. */
export function McpSummary({ content }: { content: string }) {
  const { t } = useTranslate();
  const parsed = useMemo(() => parseMcp(content), [content]);
  if (parsed.servers.length === 0) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {t("dashboard.context.fileBlocks.mcpServerCount", { count: parsed.servers.length })}
      </Typography>
      <Stack spacing={0.75}>
        {parsed.servers.map((s) => (
          <Stack key={s.name} direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {s.name}
            </Typography>
            <Chip label={s.transport} size="small" variant="outlined" />
            {s.usesRefs && (
              <Typography variant="caption" sx={{ color: "text.disabled" }}>
                {t("dashboard.context.fileBlocks.envRefsRedacted")}
              </Typography>
            )}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

interface McpServerSummary {
  name: string;
  transport: string;
  usesRefs: boolean;
}

function parseMcp(content: string): { servers: McpServerSummary[] } {
  try {
    const obj = JSON.parse(content) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers: McpServerSummary[] = Object.entries(obj.mcpServers ?? {}).map(([name, cfg]) => {
      const transport =
        (typeof cfg.type === "string" && cfg.type) || (cfg.url ? "http" : cfg.command ? "stdio" : "unknown");
      const usesRefs = /\$\{[A-Za-z_]/.test(JSON.stringify(cfg.env ?? {}) + JSON.stringify(cfg.headers ?? {}));
      return { name, transport, usesRefs };
    });
    return { servers };
  } catch {
    return { servers: [] };
  }
}

/**
 * `apps/web › skills › component-conventions` — scope label, then the segments
 * under `.outerlayer/`, dropping a trailing `SKILL.md` so the skill dir is the
 * leaf. Files outside any `.outerlayer/` show their raw path segments.
 *
 * The scope segment is the empty string for a repo-root `.outerlayer/`; the
 * caller localizes that sentinel (the "repo root" label lives in the view layer,
 * not this pure helper).
 */
export function scopeBreadcrumb(path: string): string[] {
  const segs = path.split("/");
  const idx = segs.indexOf(".outerlayer");
  if (idx === -1) return segs;

  const scope = segs.slice(0, idx).join("/");
  const rest = segs.slice(idx + 1);
  if (rest.length > 1 && rest[rest.length - 1] === "SKILL.md") rest.pop();

  return [scope, ...rest];
}
