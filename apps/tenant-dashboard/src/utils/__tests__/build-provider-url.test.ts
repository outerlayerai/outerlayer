import { buildProviderUrl } from '../build-provider-url';

describe('buildProviderUrl', () => {
  describe('commit URLs', () => {
    it('should construct a GitHub commit URL', () => {
      expect(
        buildProviderUrl('github', 'owner/repo', 'abc1234def5678', {
          type: 'commit',
        }),
      ).toBe('https://github.com/owner/repo/commit/abc1234def5678');
    });

    it('should construct a GitLab commit URL', () => {
      expect(
        buildProviderUrl('gitlab', 'group/project', 'abc1234def5678', {
          type: 'commit',
        }),
      ).toBe('https://gitlab.com/group/project/-/commit/abc1234def5678');
    });
  });

  describe('blob (file-at-commit) URLs', () => {
    it('should construct a GitHub blob URL', () => {
      expect(
        buildProviderUrl('github', 'owner/repo', 'abc1234', {
          type: 'blob',
          filePath: 'agentmark/prompts/greeting.prompt.mdx',
        }),
      ).toBe(
        'https://github.com/owner/repo/blob/abc1234/agentmark/prompts/greeting.prompt.mdx',
      );
    });

    // A hardcoded github.com blob URL (as in template-history.tsx) produces
    // broken links for GitLab-connected tenants. The single builder must emit
    // the GitLab `/-/blob/` path for `gitlab`.
    it('should construct a GitLab blob URL', () => {
      expect(
        buildProviderUrl('gitlab', 'group/project', 'abc1234', {
          type: 'blob',
          filePath: 'agentmark/prompts/greeting.prompt.mdx',
        }),
      ).toBe(
        'https://gitlab.com/group/project/-/blob/abc1234/agentmark/prompts/greeting.prompt.mdx',
      );
    });

    it('should strip a leading slash from the file path', () => {
      expect(
        buildProviderUrl('gitlab', 'group/project', 'sha9', {
          type: 'blob',
          filePath: '/nested/file.ts',
        }),
      ).toBe('https://gitlab.com/group/project/-/blob/sha9/nested/file.ts');
    });

    it('should return null for a blob URL with no file path', () => {
      expect(
        buildProviderUrl('github', 'owner/repo', 'abc1234', { type: 'blob' }),
      ).toBeNull();
    });
  });

  describe('null guards', () => {
    it('should return null when the SHA is null', () => {
      expect(
        buildProviderUrl('github', 'owner/repo', null, { type: 'commit' }),
      ).toBeNull();
    });

    it('should return null when the SHA is undefined', () => {
      expect(
        buildProviderUrl('github', 'owner/repo', undefined, { type: 'commit' }),
      ).toBeNull();
    });

    it('should return null when the repository is null', () => {
      expect(
        buildProviderUrl('github', null, 'abc1234', { type: 'commit' }),
      ).toBeNull();
    });

    it('should return null when the provider is unknown', () => {
      expect(
        buildProviderUrl('bitbucket', 'owner/repo', 'abc1234', {
          type: 'commit',
        }),
      ).toBeNull();
      expect(
        buildProviderUrl('bitbucket', 'owner/repo', 'abc1234', {
          type: 'blob',
          filePath: 'file.ts',
        }),
      ).toBeNull();
    });

    it('should return null when the provider is null', () => {
      expect(
        buildProviderUrl(null, 'owner/repo', 'abc1234', { type: 'commit' }),
      ).toBeNull();
    });
  });
});
