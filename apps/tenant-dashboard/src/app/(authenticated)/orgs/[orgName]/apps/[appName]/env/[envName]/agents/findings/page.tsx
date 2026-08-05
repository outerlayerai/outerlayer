import { notFound } from "next/navigation";
import { resolveAgentSessionsContext } from "@/features/agent-sessions/request-context";
import { agentSessionsService } from "@/features/agent-sessions/service";
import { AgentFindings } from "@/features/agent-sessions/components/agent-findings";

export default async function AgentFindingsPage({
  params,
}: {
  params: Promise<{ appName: string }>;
}) {
  const { appName } = await params;
  const ctx = await resolveAgentSessionsContext(appName);
  if (!ctx) notFound();

  const data = await agentSessionsService.getFindings(ctx);
  return <AgentFindings data={data} />;
}
