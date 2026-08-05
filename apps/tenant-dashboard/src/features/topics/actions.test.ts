/**
 * `generateTopics` server action — the writer-identity gate and its ordering.
 *
 * `analytics_readonly` holds SELECT-only grants, so generation's insert MUST
 * run on the writer identity (`getDefaultClient`), never the row-policy read
 * client; and a read-only temp-access grant (RLS's read-only promise holds
 * only for Postgres, not ClickHouse) must be refused BEFORE that writer
 * client is ever constructed. The context/permission seams are mocked (same
 * pattern as `escalations/actions.test.ts`); `authorizedAction` itself runs
 * for real.
 */

const { loadCtxMock, checkPermMock, tempAccessMock, getDefaultClientMock, buildTopicsServiceMock, revalidateMock } =
  vi.hoisted(() => ({
    loadCtxMock: vi.fn(),
    checkPermMock: vi.fn(),
    tempAccessMock: vi.fn(),
    getDefaultClientMock: vi.fn(),
    buildTopicsServiceMock: vi.fn(),
    revalidateMock: vi.fn(),
  }));
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
  isTempAccessReadOnlySession: tempAccessMock,
}));
vi.mock('@/lib/analytics/client', () => ({
  getDefaultClient: getDefaultClientMock,
}));
vi.mock('./service', () => ({
  buildTopicsService: buildTopicsServiceMock,
}));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock }));

import { generateTopics } from './actions';
import { DEFAULT_ENV_NAME } from '@/lib/environments/default-env-name';

const INSIGHTS_PATH = '/orgs/[orgName]/apps/[appName]/env/[envName]/insights';
const APP_ID = 'app-xyz';
const TENANT_ID = 'tenant-1';
/** The exact identity `generateTopics` writes into ClickHouse. Distinguishes a
 * mock-return leak from the real seamed client. */
const WRITER_CLIENT = { __writer: true };

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue({
    db: {},
    tenantId: TENANT_ID,
    actor: { userId: 'user-1', role: 'owner' },
  });
  checkPermMock.mockResolvedValue(true);
  tempAccessMock.mockResolvedValue(false);
  getDefaultClientMock.mockReturnValue(WRITER_CLIENT);
});

it('refuses a read-only temp-access session before the writer client is ever constructed', async () => {
  tempAccessMock.mockResolvedValue(true);

  const res = await generateTopics({ appId: APP_ID, facet: 'task' });

  expect(res).toMatchObject({
    ok: false,
    error: { message: 'Temporary access is read-only and cannot generate topics.' },
  });
  expect(tempAccessMock).toHaveBeenCalledWith('user-1', TENANT_ID);
  expect(getDefaultClientMock).not.toHaveBeenCalled();
  expect(buildTopicsServiceMock).not.toHaveBeenCalled();
  expect(revalidateMock).not.toHaveBeenCalled();
});

it("runs the insert on the writer identity, scoped to exactly ctx.tenantId + input.appId", async () => {
  const outcome = { status: 'generated', facet: 'task', mapVersion: 2, topicCount: 3, sampleSize: 150, noiseCount: 5, mode: 'live', generationMs: 800 };
  const serviceGenerateMock = vi.fn().mockResolvedValue(outcome);
  buildTopicsServiceMock.mockReturnValue({ generateTopics: serviceGenerateMock });

  const res = await generateTopics({ appId: APP_ID, facet: 'task' });

  expect(res).toEqual({ ok: true, data: outcome });
  // The writer client — never the row-policy read client — backs the service.
  expect(getDefaultClientMock).toHaveBeenCalledTimes(1);
  expect(buildTopicsServiceMock).toHaveBeenCalledWith(WRITER_CLIENT);
  // The scope is the verified-context tenantId + the parsed input's appId —
  // never a caller-suppliable tenant — pinned to the exact object.
  expect(serviceGenerateMock).toHaveBeenCalledWith(
    { tenantId: TENANT_ID, appId: APP_ID, environment: DEFAULT_ENV_NAME, environmentIsDefault: true },
    'task',
  );
  expect(revalidateMock).toHaveBeenCalledWith(INSIGHTS_PATH, 'page');
});
