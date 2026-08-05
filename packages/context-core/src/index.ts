// Re-exported from @outerlayer/context-format (OSS): the taxonomy, path
// utils, classifier, frontmatter parsing, the emit engine, and the
// .outerlayer/config.json parser all live there. This barrel keeps every
// `@repo/context-core` import path unchanged so
// the dashboard and context-sync need zero source churn.
export type {
  ContextKind,
  ClassifiedEntry,
  ClassifyIssue,
  ClassifyResult,
  FieldIssue,
  ValidationResult,
  ParsedContextFile,
} from '@outerlayer/context-format';

export { classifyTree } from '@outerlayer/context-format';

export { CLASSIFIER_VERSION } from '@outerlayer/context-format';

export type { ChangeStatus, TreeChange } from './tree-diff';
export { applySnapshotChanges, hasContextChanges } from './tree-diff';

export {
  skillFrontmatterSchema,
  commandFrontmatterSchema,
  subagentFrontmatterSchema,
  referenceFrontmatterSchema,
  validateFrontmatter,
} from './frontmatter/schemas';
export type { ValidateFrontmatterContext } from './frontmatter/schemas';

export { parseContextFile } from '@outerlayer/context-format';
export { serializeContextFile } from './frontmatter/serialize';

export { validateMcpConfig } from './mcp';
export type { McpConfig, McpServerConfig } from './mcp';

export { classifyPublishValidation } from './publish-severity';

export { emitTree, ALL_TARGET_IDS, parseOuterlayerConfig } from '@outerlayer/context-format';
export type {
  TargetId,
  EmitInput,
  EmitFile,
  EmitCopy,
  EmitResult,
  OuterlayerConfig,
} from '@outerlayer/context-format';
