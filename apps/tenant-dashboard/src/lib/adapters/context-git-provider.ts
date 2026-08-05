import 'server-only';

/**
 * Bridge to the legacy git-provider factory, exposed to the system layer. It
 * reads a connection's stored credentials and builds the GitHub client; the
 * system-layer resolver supplies the service-role admin client it needs to
 * reach those secrets. Lives here because the factory
 * still sits in the legacy service tree, and this adapter directory is the one
 * sanctioned crossing to it.
 */
export { createGitProviderForApp } from '@/lib/system/git';

/** The provider-error type and classifier a caller needs to construct/branch on
 * a provider call's failure mode (e.g. a deleted-at-remote-head read) without
 * importing the legacy error module directly. */
export { GitProviderError, isGitProviderError } from '@/lib/system/git/errors';
