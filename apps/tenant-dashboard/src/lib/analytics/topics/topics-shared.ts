/**
 * Client-safe Topics contracts — types + constants shared by the server-side
 * TopicsService and the client-side Topics page/hook (and by other domains,
 * such as the agent-sessions drill-down, that round-trip a topic facet
 * through the URL). Re-exported from `@repo/api-schemas`, which is where the
 * gateway's `/v1/topics` route and the `list_topics` MCP tool get the same
 * contracts — this file stays the dashboard's stable import path so nothing
 * in the app needs to change its imports.
 */
export {
  TOPIC_FACETS,
  type TopicFacet,
  parseTopicFacet,
  MIN_SUMMARIES_FOR_GENERATION,
  MIN_STEERING_SUMMARIES_FOR_GENERATION,
  generationFloorForFacet,
  type TopicsList,
  type GenerateOutcome,
} from '@repo/api-schemas';
