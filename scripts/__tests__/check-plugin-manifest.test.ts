import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { checkHookCommands, checkLauncherHasNoExternalImports, checkManifests, checkSlashCommands } from '../ci/check-plugin-manifest.mjs';

describe('claude-plugin manifest gate', () => {
  let cwd: string;
  let pluginDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'plugin-manifest-'));
    pluginDir = path.join(cwd, 'claude-plugin');
    mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function writePluginJson(fields: Record<string, unknown> = {}) {
    writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'outerlayer', version: '0.1.0', description: 'x', hooks: './hooks/hooks.json', ...fields }),
    );
  }
  function writeHooksJson(command: string) {
    writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }),
    );
  }
  function writeLauncher(source = '') {
    writeFileSync(path.join(pluginDir, 'scripts', 'hook.mjs'), source);
  }

  describe('checkManifests', () => {
    it('accepts a well-formed plugin.json and hooks.json', () => {
      writePluginJson();
      writeHooksJson('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" SessionStart');
      const { problems } = checkManifests(pluginDir);
      expect(problems).toEqual([]);
    });

    it('reports every missing required field', () => {
      writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'outerlayer' }));
      writeHooksJson('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" SessionStart');
      const { problems } = checkManifests(pluginDir);
      expect(problems).toEqual([
        'plugin.json is missing required field "version"',
        'plugin.json is missing required field "description"',
        'plugin.json is missing required field "hooks"',
      ]);
    });

    it('reports corrupt JSON instead of throwing', () => {
      writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{ not json');
      writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), '{ also not json');
      const { problems, plugin, hooksJson } = checkManifests(pluginDir);
      expect(plugin).toBeNull();
      expect(hooksJson).toBeNull();
      expect(problems).toHaveLength(2);
    });
  });

  describe('checkHookCommands', () => {
    it('flags a command that does not go through ${CLAUDE_PLUGIN_ROOT}', () => {
      const problems = checkHookCommands(pluginDir, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node scripts/hook.mjs Stop' }] }] },
      });
      expect(problems).toEqual(['Stop: command does not reference "${CLAUDE_PLUGIN_ROOT}/...": node scripts/hook.mjs Stop']);
    });

    it('flags a ${CLAUDE_PLUGIN_ROOT} reference to a file that is not scripts/hook.mjs', () => {
      writeLauncher();
      writeFileSync(path.join(pluginDir, 'scripts', 'other.mjs'), '');
      const problems = checkHookCommands(pluginDir, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/other.mjs" Stop' }] }] },
      });
      expect(problems).toEqual(['Stop: command references "scripts/other.mjs", expected it to end in "scripts/hook.mjs"']);
    });

    it('flags a referenced file that does not exist on disk', () => {
      const problems = checkHookCommands(pluginDir, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" Stop' }] }] },
      });
      expect(problems).toEqual(['Stop: command references "scripts/hook.mjs", which does not exist in the plugin directory']);
    });

    it('accepts a valid reference to an existing file', () => {
      writeLauncher();
      const problems = checkHookCommands(pluginDir, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" Stop' }] }] },
      });
      expect(problems).toEqual([]);
    });
  });

  describe('checkLauncherHasNoExternalImports', () => {
    it('accepts node builtin imports only', () => {
      writeLauncher('import { existsSync } from "node:fs";\nimport { homedir } from "os";\n');
      expect(checkLauncherHasNoExternalImports(pluginDir)).toEqual([]);
    });

    it('flags an import statement of a non-builtin package', () => {
      writeLauncher('import foo from "lodash";\n');
      expect(checkLauncherHasNoExternalImports(pluginDir)).toEqual(['scripts/hook.mjs imports "lodash", which is not a node builtin']);
    });

    it('flags a require() of a non-builtin package', () => {
      writeLauncher('const bar = require("chalk");\n');
      expect(checkLauncherHasNoExternalImports(pluginDir)).toEqual(['scripts/hook.mjs imports "chalk", which is not a node builtin']);
    });

    it('reports a missing launcher file rather than throwing', () => {
      expect(checkLauncherHasNoExternalImports(pluginDir)).toEqual([
        `${path.join(pluginDir, 'scripts', 'hook.mjs')} does not exist`,
      ]);
    });
  });

  describe('checkSlashCommands', () => {
    function writeCommand(name: string, content: string) {
      const dir = path.join(pluginDir, 'commands');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }

    it('accepts no commands directory at all', () => {
      expect(checkSlashCommands(pluginDir)).toEqual([]);
    });

    it('accepts a well-formed command with frontmatter and a description', () => {
      writeCommand('connect.md', '---\ndescription: Connect this machine\n---\n\nDo the thing.\n');
      expect(checkSlashCommands(pluginDir)).toEqual([]);
    });

    it('flags a non-markdown file in commands/', () => {
      writeCommand('connect.txt', 'not markdown');
      expect(checkSlashCommands(pluginDir)).toEqual([
        'commands/connect.txt is not a .md file — every slash command must be markdown',
      ]);
    });

    it('flags a command file with no frontmatter block', () => {
      writeCommand('connect.md', 'Just do the thing, no frontmatter.\n');
      expect(checkSlashCommands(pluginDir)).toEqual([
        'commands/connect.md has no YAML frontmatter block (expected to start with "---")',
      ]);
    });

    it('flags frontmatter with no description field', () => {
      writeCommand('connect.md', '---\nother: value\n---\n\nBody.\n');
      expect(checkSlashCommands(pluginDir)).toEqual([
        'commands/connect.md frontmatter is missing a non-empty "description"',
      ]);
    });

    it('flags frontmatter with an empty description', () => {
      writeCommand('connect.md', '---\ndescription:   \n---\n\nBody.\n');
      expect(checkSlashCommands(pluginDir)).toEqual([
        'commands/connect.md frontmatter is missing a non-empty "description"',
      ]);
    });
  });
});
