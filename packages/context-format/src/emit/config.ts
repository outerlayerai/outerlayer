/**
 * `.outerlayer/config.json` parsing + validation. Explicit
 * per-target opt-in — empty/missing `targets` and unknown target ids are
 * both hard errors; there is no default target set. Never throws.
 */
import type { FieldIssue, ValidationResult } from '../kinds';
import { ALL_TARGET_IDS, type TargetId } from './types';

/** The parsed shape of `.outerlayer/config.json` — the CLI reads `.targets`
 * straight into `EmitInput.targets` (flat, per the current `EmitInput` shape). */
export interface OuterlayerConfig {
  targets: TargetId[];
}

export function parseOuterlayerConfig(json: string): ValidationResult & { config?: OuterlayerConfig } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '(root)', code: 'invalid_json', message: err instanceof Error ? err.message : 'invalid JSON' }],
      warnings: [],
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ path: '(root)', code: 'invalid_type', message: 'config.json must be a JSON object' }],
      warnings: [],
    };
  }

  const targetsRaw = (raw as Record<string, unknown>).targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    return {
      ok: false,
      errors: [
        {
          path: 'targets',
          code: 'no_targets',
          message: `"targets" must be a non-empty array of target ids; valid ids: ${ALL_TARGET_IDS.join(', ')}`,
        },
      ],
      warnings: [],
    };
  }

  const validIds = new Set<string>(ALL_TARGET_IDS);
  const errors: FieldIssue[] = [];
  const targets: TargetId[] = [];

  targetsRaw.forEach((t, i) => {
    if (typeof t !== 'string' || !validIds.has(t)) {
      errors.push({
        path: `targets[${i}]`,
        code: 'unknown_target',
        message: `unknown target id ${JSON.stringify(t)}; valid ids: ${ALL_TARGET_IDS.join(', ')}`,
      });
      return;
    }
    targets.push(t as TargetId);
  });

  if (errors.length > 0) return { ok: false, errors, warnings: [] };

  return { ok: true, errors: [], warnings: [], config: { targets } };
}
