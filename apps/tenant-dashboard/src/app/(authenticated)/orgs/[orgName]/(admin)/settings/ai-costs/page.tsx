import { AiCostForm } from "@/features/ai-cost";
// `loadAiCostConfig` is imported by path, not the barrel: it guards itself
// with `server-only`, and the barrel only re-exports the "use client" form —
// keeping the server-only read off the barrel keeps a client bundle from
// ever pulling it in through the shared module graph.
import { loadAiCostConfig } from "@/features/ai-cost/read";

export const metadata = {
  title: "Settings: AI costs",
};

export default async function AiCostsSettingsPage() {
  const config = await loadAiCostConfig();
  return <AiCostForm initial={config} />;
}
