"use client";

/**
 * Usage tab for a selected mcp.json: a server table (server · last used ·
 * calls · sessions) with never-used rows leading — they cost context every
 * session — and a per-server expansion holding the tool breakdown and the
 * calling sessions. The tool list can only show tools that were CALLED —
 * tool definitions live on the server at runtime, not in mcp.json — so the
 * copy says "N tools used", never claiming to know how many exist. Servers
 * with recorded usage that aren't in this file are named in the
 * configured-outside-this-repo note rather than silently merged in.
 */
import { Fragment, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { LocalDate } from "@/components/local-date";
import { parseAdoptionTimestamp } from "./adoption-time";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { appPaths } from "../../../routes/paths";
import { useOptionalEnvContext, DEFAULT_ENV_NAME } from "../../../context/env-context";
import { useAppContext } from "@/lib/app-shell/app-context";
import { useContextMcpAdoption, useContextMcpDrilldown } from "../hooks";
import {
  AdoptionSessionRow,
  NeverUsedText,
  RelativeTimeText,
} from "./context-adoption-widgets";
import { indexMcpUsage, mcpServerStatus } from "./context-mcp-adoption";

/** Sessions shown per server; the API already caps and orders recent-first. */
const SESSION_ROWS = 8;
/** Tools listed before collapsing into a "+N more" line. */
const TOOL_ROWS = 10;

/**
 * Content | Usage tab pair wrapped around the mcp.json editor pane. The
 * editor (or its loading/error states) rides in as `children` so every
 * existing file-pane behavior is preserved unchanged on the Content tab.
 */
export function McpDetailTabs({
  servers,
  children,
}: {
  servers: string[];
  children: React.ReactNode;
}) {
  const { t } = useTranslate();
  const [tab, setTab] = useState<"content" | "usage">("content");
  return (
    <Stack sx={{ height: 1, minHeight: 0 }} data-testid="mcp-detail-tabs">
      <Tabs
        value={tab}
        onChange={(_e, next: "content" | "usage") => setTab(next)}
        sx={{ px: 2, flexShrink: 0, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Tab value="content" label={t("dashboard.context.view.tabContent")} data-testid="mcp-tab-content" />
        <Tab value="usage" label={t("dashboard.context.view.tabUsage")} data-testid="mcp-tab-usage" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab === "content" ? children : <McpUsageTab servers={servers} />}
      </Box>
    </Stack>
  );
}

function McpUsageTab({ servers }: { servers: string[] }) {
  const { t } = useTranslate();
  const { app } = useAppContext();
  const appId = app?.id ?? "";
  const { data, isLoading } = useContextMcpAdoption(appId);
  const [expanded, setExpanded] = useState<string | null>(null);

  const usage = useMemo(() => (data ? indexMcpUsage(data.servers) : undefined), [data]);
  // Never-used servers lead (the actionable rows), then most recently used
  // first — the same recency-is-the-signal ordering as the tree column.
  const ordered = useMemo(() => {
    const never = servers.filter((s) => usage && mcpServerStatus(usage.get(s)) === "never").sort();
    const used = servers
      .filter((s) => !never.includes(s))
      .sort((a, b) => (usage?.get(b)?.lastUsedAt ?? "").localeCompare(usage?.get(a)?.lastUsedAt ?? ""));
    return [...never, ...used];
  }, [servers, usage]);
  // Servers with recorded usage that aren't in this mcp.json — user-level or
  // CLI-configured. Shown so their usage can't be misread as one of the
  // installed servers going unaccounted.
  const outside = useMemo(() => {
    if (!data) return [];
    const installed = new Set(servers);
    return data.servers.filter((s) => !installed.has(s.serverName)).map((s) => s.serverName);
  }, [data, servers]);

  if (isLoading || !usage) {
    return (
      <Typography variant="caption" sx={{ color: "text.disabled", display: "block", p: 3 }}>
        {t("dashboard.context.tree.drilldownLoading")}
      </Typography>
    );
  }

  return (
    <Box sx={{ p: 3, height: 1, overflow: "auto" }} data-testid="mcp-usage-pane">
      <Table size="small" sx={{ maxWidth: 640 }}>
        <TableHead>
          <TableRow>
            <TableCell>{t("dashboard.context.view.usageColServer")}</TableCell>
            <TableCell>{t("dashboard.context.view.usageColLastUsed")}</TableCell>
            <TableCell align="right">{t("dashboard.context.view.usageColCalls")}</TableCell>
            <TableCell align="right">{t("dashboard.context.view.usageColSessions")}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {ordered.map((name) => {
            const row = usage.get(name);
            const never = mcpServerStatus(row) === "never";
            const open = expanded === name;
            return (
              <Fragment key={name}>
                <TableRow
                  hover
                  onClick={() => setExpanded(open ? null : name)}
                  data-testid={`mcp-server-row-${name}`}
                  sx={{ cursor: "pointer", "& td": { borderBottom: open ? 0 : undefined } }}
                >
                  <TableCell>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                      <Iconify
                        icon={open ? "mdi:chevron-down" : "mdi:chevron-right"}
                        width={14}
                        sx={{ color: "text.disabled", flexShrink: 0 }}
                      />
                      <Typography variant="body2" sx={{ fontSize: 13 }}>
                        {name}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {never ? (
                      <NeverUsedText
                        tip={t("dashboard.context.tree.lastUsedNeverMcpTip")}
                        testId={`mcp-last-used-never-${name}`}
                      />
                    ) : (
                      <RelativeTimeText value={row?.lastUsedAt ?? null} testId={`mcp-last-used-${name}`} />
                    )}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {row?.totalCalls ?? 0}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {row?.totalSessions ?? 0}
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ pt: 0, pl: 4.5 }}>
                      <ServerDetail server={name} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {outside.length > 0 && (
        <Typography variant="caption" sx={{ color: "text.disabled", display: "block", mt: 1.5 }}>
          {t("dashboard.context.tree.mcpOutsideRepo", { names: outside.join(", ") })}
        </Typography>
      )}
    </Box>
  );
}

function ServerDetail({ server }: { server: string }) {
  const { t } = useTranslate();
  const { app } = useAppContext();
  const appId = app?.id ?? "";
  const params = useParams<{ orgName: string; appName: string }>();
  const envName = useOptionalEnvContext()?.selectedEnv.name ?? DEFAULT_ENV_NAME;
  const { data, isLoading, error } = useContextMcpDrilldown(appId, server);

  if (isLoading) {
    return (
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        {t("dashboard.context.tree.drilldownLoading")}
      </Typography>
    );
  }
  if (error || !data) {
    return (
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        {t("dashboard.context.tree.drilldownUnavailable")}
      </Typography>
    );
  }
  const quietTools = data.tools.filter((tool) => tool.recentCalls === 0).length;
  return (
    <Stack spacing={1} data-testid={`mcp-server-detail-${server}`}>
      {data.tools.length > 0 && (
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
            {t("dashboard.context.tree.mcpToolsUsed", { count: data.tools.length })}
            {quietTools > 0 ? ` ${t("dashboard.context.tree.mcpToolsQuiet", { count: quietTools })}` : ""}
          </Typography>
          <Stack spacing={0.25}>
            {data.tools.slice(0, TOOL_ROWS).map((tool) => (
              <Stack key={tool.tool} direction="row" spacing={1} sx={{ alignItems: "baseline", minWidth: 0 }}>
                <Typography
                  variant="caption"
                  data-testid="mcp-tool-row"
                  sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {tool.tool}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
                  {tool.totalCalls}× · <LocalDate value={parseAdoptionTimestamp(tool.lastUsedAt)} format="monthDay" absent="" />
                </Typography>
              </Stack>
            ))}
            {data.tools.length > TOOL_ROWS && (
              <Typography variant="caption" sx={{ color: "text.disabled" }}>
                {t("dashboard.context.tree.mcpToolsMore", { count: data.tools.length - TOOL_ROWS })}
              </Typography>
            )}
          </Stack>
        </Box>
      )}
      {data.sessions.length > 0 && (
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
            {t("dashboard.context.tree.drilldownSessions")}
          </Typography>
          <Stack spacing={0.25}>
            {data.sessions.slice(0, SESSION_ROWS).map((s) => (
              <AdoptionSessionRow
                key={s.traceId}
                label={s.title || s.traceId.slice(0, 12)}
                suffix={
                  <>
                    <LocalDate value={parseAdoptionTimestamp(s.lastUsedAt)} format="monthDay" absent="" />
                    {s.calls > 1 ? ` · ${s.calls}×` : ""}
                  </>
                }
                href={appPaths.agents.session(params.orgName, params.appName, envName, s.traceId)}
              />
            ))}
          </Stack>
        </Box>
      )}
      {data.tools.length === 0 && data.sessions.length === 0 && (
        <Typography variant="caption" sx={{ color: "text.disabled" }}>
          {t("dashboard.context.tree.mcpEmpty", { days: data.lookbackDays })}
        </Typography>
      )}
    </Stack>
  );
}
