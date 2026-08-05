/**
 * Shared rich fixture for emitter tests: nested scopes, two
 * skills (one with a reference + assets, one with only an asset), commands,
 * mcp with `${VAR}` + `${VAR:-default}` + a tool-specific key, and a
 * root-external `CLAUDE.md` that must never be treated as an emit source.
 * Built from a raw path list through the real `classifyTree`, so the fixture
 * stays honest about what the classifier actually produces.
 */
import { classifyTree } from '../classify';
import type { EmitInput } from './types';

const FIXTURE_PATHS = [
  'CLAUDE.md',
  '.outerlayer/AGENTS.md',
  'apps/api/.outerlayer/AGENTS.md',
  '.outerlayer/skills/deploy-checklist/SKILL.md',
  '.outerlayer/skills/deploy-checklist/scripts/run.sh',
  '.outerlayer/skills/onboarding/SKILL.md',
  '.outerlayer/skills/onboarding/references/setup.md',
  '.outerlayer/skills/onboarding/assets/logo.png',
  '.outerlayer/commands/ship.md',
  '.outerlayer/mcp.json',
];

const FIXTURE_CONTENTS: ReadonlyMap<string, string> = new Map([
  // Content IS available for the root-external marker, on purpose: proves
  // emit ignores it because it's classified `external-instructions` (a
  // target, not a source), not merely because no content was supplied.
  ['CLAUDE.md', '# Legacy\nDo not use — this file is a compile target, not a source.\n'],
  ['.outerlayer/AGENTS.md', 'Root instructions.\n'],
  ['apps/api/.outerlayer/AGENTS.md', 'API scope instructions.\n'],
  [
    '.outerlayer/skills/deploy-checklist/SKILL.md',
    '---\nname: deploy-checklist\ndescription: Steps to deploy safely.\n---\nRun the checklist.\n',
  ],
  [
    '.outerlayer/skills/onboarding/SKILL.md',
    '---\nname: onboarding\ndescription: Onboard a new engineer.\n---\nRead the docs.\n',
  ],
  ['.outerlayer/skills/onboarding/references/setup.md', 'Install dependencies.\n'],
  [
    '.outerlayer/commands/ship.md',
    '---\ndescription: Ship the current branch.\nargument-hint: <version>\n---\nRun the ship script.\n',
  ],
  [
    '.outerlayer/mcp.json',
    '{\n  "mcpServers": {\n    "api": {\n      "url": "${API_URL:-https://api.example.com}",\n      "headers": {\n        "Authorization": "${API_TOKEN}"\n      },\n      "type": "http",\n      "oauth": true\n    }\n  }\n}\n',
  ],
]);

const FIXTURE_ASSET_PATHS = [
  '.outerlayer/skills/deploy-checklist/scripts/run.sh',
  '.outerlayer/skills/onboarding/assets/logo.png',
];

export function fixtureInput(targets: EmitInput['targets']): EmitInput {
  const { entries } = classifyTree(FIXTURE_PATHS);
  return {
    entries,
    contents: FIXTURE_CONTENTS,
    assetPaths: FIXTURE_ASSET_PATHS,
    targets,
  };
}
