export type {
  ContextKind,
  ClassifiedEntry,
  ClassifyIssue,
  ClassifyResult,
  FieldIssue,
  ValidationResult,
  ParsedContextFile,
} from './kinds';

export { normalizePath, segments, joinPath, dirname, basename, isAncestorScope } from './path-utils';

export { classifyTree } from './classify';

export { CLASSIFIER_VERSION } from './classifier-version';

export { parseContextFile, splitRawFile } from './frontmatter/parse';
export type { SplitRawFile } from './frontmatter/parse';

export { emitTree, mergeEmitResults, ALL_TARGET_IDS } from './emit/index';
export type {
  TargetId,
  EmitInput,
  EmitFile,
  EmitCopy,
  EmitResult,
  TargetBuildResult,
} from './emit/index';
export { cursorEnvRefRewrite, findEnvRefs, rewriteEnvRefs } from './emit/index';
export type { EnvRef, RewriteEnvRefsResult } from './emit/index';

export { parseOuterlayerConfig } from './emit/index';
export type { OuterlayerConfig } from './emit/index';
