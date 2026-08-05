import { describe, expect, it } from 'vitest';
import { classifyTree } from './classify';
import type { ClassifiedEntry } from './kinds';

describe('classifyTree — table-driven positional shape', () => {
  it('classifies every kind at repo root in one pass', () => {
    const paths = [
      '.outerlayer/AGENTS.md',
      '.outerlayer/skills/deploy-checklist/SKILL.md',
      '.outerlayer/skills/deploy-checklist/references/rollback.md',
      '.outerlayer/skills/deploy-checklist/scripts/run.sh',
      '.outerlayer/commands/ship.md',
      '.outerlayer/agents/reviewer.md',
      '.outerlayer/mcp.json',
      '.outerlayer/notes.md',
    ];

    const result = classifyTree(paths);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/AGENTS.md', kind: 'instructions', scopePath: '' },
      { path: '.outerlayer/skills/deploy-checklist/SKILL.md', kind: 'skill', scopePath: '', skillName: 'deploy-checklist' },
      {
        path: '.outerlayer/skills/deploy-checklist/references/rollback.md',
        kind: 'skill-reference',
        scopePath: '',
        skillName: 'deploy-checklist',
      },
      { path: '.outerlayer/commands/ship.md', kind: 'command', scopePath: '' },
      { path: '.outerlayer/agents/reviewer.md', kind: 'subagent', scopePath: '' },
      { path: '.outerlayer/mcp.json', kind: 'mcp', scopePath: '' },
      { path: '.outerlayer/notes.md', kind: 'reference', scopePath: '' },
    ]);

    expect(result.excludedCounts).toEqual([{ scopePath: '', skillName: 'deploy-checklist', count: 1 }]);
    expect(result.issues).toEqual([]);
  });

  it('classifies .outerlayer/config.json as an unrecognized non-.md file — excluded, no entry, no skill count', () => {
    const result = classifyTree(['.outerlayer/config.json']);

    expect(result.entries).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('discovers nested .outerlayer/ dirs at three depths in a monorepo, each with its own scope', () => {
    const paths = [
      '.outerlayer/AGENTS.md',
      'apps/api/.outerlayer/AGENTS.md',
      'apps/api/workers/billing/.outerlayer/AGENTS.md',
    ];

    const result = classifyTree(paths);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/AGENTS.md', kind: 'instructions', scopePath: '' },
      { path: 'apps/api/.outerlayer/AGENTS.md', kind: 'instructions', scopePath: 'apps/api' },
      {
        path: 'apps/api/workers/billing/.outerlayer/AGENTS.md',
        kind: 'instructions',
        scopePath: 'apps/api/workers/billing',
      },
    ]);
  });

  it('flags a skill missing SKILL.md as invalid and demotes its references to plain reference kind', () => {
    const paths = [
      '.outerlayer/skills/orphan/references/notes.md',
      '.outerlayer/skills/orphan/scripts/helper.sh',
    ];

    const result = classifyTree(paths);

    expect(result.issues).toEqual([
      {
        type: 'missing-skill-md',
        path: '.outerlayer/skills/orphan/SKILL.md',
        scopePath: '',
        detail: 'skill "orphan" has no SKILL.md',
      },
    ]);
    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/skills/orphan/references/notes.md', kind: 'reference', scopePath: '' },
    ]);
  });

  it('flags a skill with only excluded assets and no SKILL.md/references as invalid too', () => {
    const paths = ['.outerlayer/skills/assets-only/scripts/run.sh'];

    const result = classifyTree(paths);

    expect(result.issues).toEqual([
      {
        type: 'missing-skill-md',
        path: '.outerlayer/skills/assets-only/SKILL.md',
        scopePath: '',
        detail: 'skill "assets-only" has no SKILL.md',
      },
    ]);
    expect(result.entries).toEqual([]);
  });

  it('detects nearest-scope-wins shadowing for a skill defined at both a scope and its child scope', () => {
    const paths = ['.outerlayer/skills/deploy/SKILL.md', 'apps/api/.outerlayer/skills/deploy/SKILL.md'];

    const result = classifyTree(paths);

    expect(result.issues).toEqual([
      {
        type: 'shadowed',
        path: '.outerlayer/skills/deploy/SKILL.md',
        scopePath: '',
        detail: 'skill "deploy" is shadowed by a nearer definition at "apps/api"',
      },
    ]);
  });

  it('does not report shadowing for the same command name in unrelated sibling scopes', () => {
    const paths = ['apps/api/.outerlayer/commands/ship.md', 'apps/web/.outerlayer/commands/ship.md'];

    const result = classifyTree(paths);

    expect(result.issues).toEqual([]);
  });

  it('resolves a three-level shadow chain into one issue per shadowed ancestor, both pointing at the same winner', () => {
    const paths = [
      '.outerlayer/commands/ship.md',
      'apps/api/.outerlayer/commands/ship.md',
      'apps/api/workers/billing/.outerlayer/commands/ship.md',
    ];

    const result = classifyTree(paths);

    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.type === 'shadowed')).toBe(true);
    expect(result.issues.every((issue) => issue.detail.includes('apps/api/workers/billing'))).toBe(true);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      '.outerlayer/commands/ship.md',
      'apps/api/.outerlayer/commands/ship.md',
    ]);
  });

  it('excludes non-md files outside skill dirs from entries without per-skill counting', () => {
    const paths = ['.outerlayer/logo.png', '.outerlayer/commands/deploy.sh'];

    const result = classifyTree(paths);

    expect(result.entries).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
  });

  it('detects root CLAUDE.md and AGENTS.md outside .outerlayer/ as read-only external-instructions', () => {
    const paths = ['AGENTS.md', 'CLAUDE.md', 'apps/api/AGENTS.md', '.outerlayer/AGENTS.md'];

    const result = classifyTree(paths);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: 'AGENTS.md', kind: 'external-instructions', scopePath: '' },
      { path: 'CLAUDE.md', kind: 'external-instructions', scopePath: '' },
      { path: 'apps/api/AGENTS.md', kind: 'external-instructions', scopePath: 'apps/api' },
      { path: '.outerlayer/AGENTS.md', kind: 'instructions', scopePath: '' },
    ]);
  });

  it('treats a file literally named .outerlayer (no directory) as ignored, not a scope root', () => {
    const result = classifyTree(['project/.outerlayer']);

    expect(result.entries).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
  });

  it('normalizes backslash path separators before classifying', () => {
    const result = classifyTree(['apps\\api\\.outerlayer\\skills\\deploy\\SKILL.md']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      {
        path: 'apps/api/.outerlayer/skills/deploy/SKILL.md',
        kind: 'skill',
        scopePath: 'apps/api',
        skillName: 'deploy',
      },
    ]);
  });

  it('ignores paths unrelated to any .outerlayer/ dir and not root AGENTS.md/CLAUDE.md', () => {
    const result = classifyTree(['README.md', 'src/index.ts', 'apps/api/package.json']);

    expect(result.entries).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
  });

  it('classifies a deeply nested skill-reference file at any depth under references/, given a valid SKILL.md', () => {
    const result = classifyTree([
      '.outerlayer/skills/foo/SKILL.md',
      '.outerlayer/skills/foo/references/nested/deep/notes.md',
    ]);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/skills/foo/SKILL.md', kind: 'skill', scopePath: '', skillName: 'foo' },
      {
        path: '.outerlayer/skills/foo/references/nested/deep/notes.md',
        kind: 'skill-reference',
        scopePath: '',
        skillName: 'foo',
      },
    ]);
    expect(result.issues).toEqual([]);
  });
});

describe('classifyTree v3 — regression: existing corpus is unchanged apart from new fields', () => {
  // Every v2 kind, at root and a nested scope. v3 must classify this exactly as
  // v2 did: no namespace field appears (all commands are flat), and no new
  // issue types fire. This is the byte-identical migration guarantee.
  it('classifies a full pre-v3 corpus with the same entries and no new fields or issues', () => {
    const result = classifyTree([
      'CLAUDE.md',
      '.outerlayer/AGENTS.md',
      '.outerlayer/skills/deploy-checklist/SKILL.md',
      '.outerlayer/skills/deploy-checklist/references/rollback.md',
      '.outerlayer/skills/deploy-checklist/scripts/run.sh',
      '.outerlayer/commands/ship.md',
      '.outerlayer/agents/reviewer.md',
      '.outerlayer/mcp.json',
      '.outerlayer/notes.md',
      'apps/api/.outerlayer/AGENTS.md',
      'apps/api/.outerlayer/commands/deploy.md',
    ]);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: 'CLAUDE.md', kind: 'external-instructions', scopePath: '' },
      { path: '.outerlayer/AGENTS.md', kind: 'instructions', scopePath: '' },
      { path: '.outerlayer/skills/deploy-checklist/SKILL.md', kind: 'skill', scopePath: '', skillName: 'deploy-checklist' },
      {
        path: '.outerlayer/skills/deploy-checklist/references/rollback.md',
        kind: 'skill-reference',
        scopePath: '',
        skillName: 'deploy-checklist',
      },
      { path: '.outerlayer/commands/ship.md', kind: 'command', scopePath: '' },
      { path: '.outerlayer/agents/reviewer.md', kind: 'subagent', scopePath: '' },
      { path: '.outerlayer/mcp.json', kind: 'mcp', scopePath: '' },
      { path: '.outerlayer/notes.md', kind: 'reference', scopePath: '' },
      { path: 'apps/api/.outerlayer/AGENTS.md', kind: 'instructions', scopePath: 'apps/api' },
      { path: 'apps/api/.outerlayer/commands/deploy.md', kind: 'command', scopePath: 'apps/api' },
    ]);
    expect(result.excludedCounts).toEqual([{ scopePath: '', skillName: 'deploy-checklist', count: 1 }]);
    expect(result.issues).toEqual([]);
    expect(result.entries.every((e) => !('namespace' in e))).toBe(true);
  });
});

describe('classifyTree v3 — nested command namespaces', () => {
  it('classifies a namespaced command at any depth with the intermediate segments as its namespace', () => {
    const result = classifyTree([
      '.outerlayer/commands/deploy/ship.md',
      '.outerlayer/commands/deploy/preview/spin-up.md',
    ]);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/commands/deploy/ship.md', kind: 'command', scopePath: '', namespace: ['deploy'] },
      {
        path: '.outerlayer/commands/deploy/preview/spin-up.md',
        kind: 'command',
        scopePath: '',
        namespace: ['deploy', 'preview'],
      },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('keeps a flat command byte-identical to v2 — no namespace field is added', () => {
    const result = classifyTree(['.outerlayer/commands/ship.md']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/commands/ship.md', kind: 'command', scopePath: '' },
    ]);
    expect(result.entries[0]).not.toHaveProperty('namespace');
    expect(result.issues).toEqual([]);
  });

  it('demotes a command with an invalid namespace segment to reference and reports a misplaced issue', () => {
    const result = classifyTree(['.outerlayer/commands/Deploy Prod/ship.md']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/commands/Deploy Prod/ship.md', kind: 'reference', scopePath: '' },
    ]);
    expect(result.issues).toEqual([
      {
        type: 'misplaced',
        path: '.outerlayer/commands/Deploy Prod/ship.md',
        scopePath: '',
        detail: 'command namespace segment "Deploy Prod" is not a valid name (lowercase alphanumeric with single hyphens)',
      },
    ]);
  });

  it('leaves a non-.md file under commands/ excluded, exactly as v2 did', () => {
    const result = classifyTree(['.outerlayer/commands/deploy/run.sh']);

    expect(result.entries).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('classifyTree v3 — misplaced subagents (agents/ stays flat)', () => {
  it('keeps a flat subagent as subagent with no issue', () => {
    const result = classifyTree(['.outerlayer/agents/reviewer.md']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/agents/reviewer.md', kind: 'subagent', scopePath: '' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('classifies a nested agent file as reference and flags it misplaced rather than silently demoting', () => {
    const result = classifyTree(['.outerlayer/agents/team/reviewer.md']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/agents/team/reviewer.md', kind: 'reference', scopePath: '' },
    ]);
    expect(result.issues).toEqual([
      {
        type: 'misplaced',
        path: '.outerlayer/agents/team/reviewer.md',
        scopePath: '',
        detail: 'subagents live directly in agents/; the frontmatter "name" is the identity, so folders add nothing',
      },
    ]);
  });
});

describe('classifyTree v3 — .gitkeep folder entries', () => {
  it('classifies a .gitkeep at any depth as a folder entry, content never read', () => {
    const result = classifyTree([
      '.outerlayer/.gitkeep',
      '.outerlayer/docs/guides/.gitkeep',
      'apps/api/.outerlayer/commands/deploy/.gitkeep',
    ]);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/.gitkeep', kind: 'folder', scopePath: '' },
      { path: '.outerlayer/docs/guides/.gitkeep', kind: 'folder', scopePath: '' },
      { path: 'apps/api/.outerlayer/commands/deploy/.gitkeep', kind: 'folder', scopePath: 'apps/api' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('treats a .gitkeep inside a skill dir as a folder, not an excluded skill asset', () => {
    const result = classifyTree(['.outerlayer/skills/onboarding/.gitkeep']);

    expect(result.entries).toEqual<ClassifiedEntry[]>([
      { path: '.outerlayer/skills/onboarding/.gitkeep', kind: 'folder', scopePath: '' },
    ]);
    // No missing-skill-md issue: the keeper is a folder, not an orphan skill asset.
    expect(result.issues).toEqual([]);
    expect(result.excludedCounts).toEqual([]);
  });
});

describe('classifyTree v3 — namespace-aware command shadowing', () => {
  it('does NOT shadow a namespaced command with a same-basename flat command in an ancestor scope', () => {
    const result = classifyTree([
      '.outerlayer/commands/ship.md',
      'apps/api/.outerlayer/commands/deploy/ship.md',
    ]);

    expect(result.issues).toEqual([]);
  });

  it('DOES shadow the same namespaced command name across ancestor/child scopes', () => {
    const result = classifyTree([
      '.outerlayer/commands/deploy/ship.md',
      'apps/api/.outerlayer/commands/deploy/ship.md',
    ]);

    expect(result.issues).toEqual([
      {
        type: 'shadowed',
        path: '.outerlayer/commands/deploy/ship.md',
        scopePath: '',
        detail: 'command "deploy/ship" is shadowed by a nearer definition at "apps/api"',
      },
    ]);
  });
});
