// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeleteContextDialog } from "./delete-dialog";

const mockEnumerate = vi.fn();

// Render with the real i18n + en.json so the unmanaged-asset marker and body
// copy assertions prove the translation keys and params resolve to shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

vi.mock("@/features/context/action-adapters", () => ({
  enumerateSkillDeletionAction: (...args: unknown[]) => mockEnumerate(...args),
}));

vi.mock("@mui/material", async () => {
  const actual = await vi.importActual<typeof import("@mui/material")>(
    "@mui/material",
  );
  return {
    ...actual,
    Dialog: ({ children, open }: any) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogContentText: ({ children, ...rest }: any) => <p {...rest}>{children}</p>,
    DialogActions: ({ children }: any) => <div>{children}</div>,
  };
});

const SKILL_DIR = ".outerlayer/skills/deploy-checklist";
const CONTENT_PATHS = [
  `${SKILL_DIR}/SKILL.md`,
  `${SKILL_DIR}/references/notes.md`,
];
const ASSET_PATHS = [`${SKILL_DIR}/assets/logo.png`, `${SKILL_DIR}/scripts/run.sh`];
const ALL_PATHS = [...CONTENT_PATHS, ...ASSET_PATHS].sort();
const SHAS = {
  [`${SKILL_DIR}/SKILL.md`]: "sha-skill",
  [`${SKILL_DIR}/references/notes.md`]: "sha-notes",
  [`${SKILL_DIR}/assets/logo.png`]: "sha-logo",
  [`${SKILL_DIR}/scripts/run.sh`]: "sha-script",
};

beforeEach(() => {
  mockEnumerate.mockReset();
});

describe("DeleteContextDialog — skill directory", () => {
  it("enumerates up front and lists every file, marking the unmanaged assets", async () => {
    mockEnumerate.mockResolvedValue({
      data: {
        status: "ok",
        enumeration: { paths: ALL_PATHS, assetPaths: ASSET_PATHS, shas: SHAS },
      },
    });

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "skill", skillDir: SKILL_DIR }}
        onStage={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(mockEnumerate).toHaveBeenCalledWith("app-1", SKILL_DIR);

    await waitFor(() =>
      expect(screen.getAllByTestId("deletion-file")).toHaveLength(4),
    );

    const rows = screen.getAllByTestId("deletion-file");
    const rowText = rows.map((r) => r.textContent ?? "");
    // All four paths present.
    for (const path of ALL_PATHS) {
      expect(rowText.some((t) => t.includes(path))).toBe(true);
    }
    // Both assets — and only the assets — carry the "will also be marked" marker.
    const markedRows = rowText.filter((t) =>
      t.includes("not managed by OuterLayer"),
    );
    expect(markedRows).toHaveLength(2);
    expect(markedRows.some((t) => t.includes("assets/logo.png"))).toBe(true);
    expect(markedRows.some((t) => t.includes("scripts/run.sh"))).toBe(true);
  });

  it("confirm stages every enumerated path against its freshly-read blob sha, then closes", async () => {
    mockEnumerate.mockResolvedValue({
      data: {
        status: "ok",
        enumeration: { paths: ALL_PATHS, assetPaths: ASSET_PATHS, shas: SHAS },
      },
    });
    const onStage = vi.fn();
    const onClose = vi.fn();

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "skill", skillDir: SKILL_DIR }}
        onStage={onStage}
        onClose={onClose}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("delete-confirm")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("delete-confirm"));

    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage).toHaveBeenCalledWith(
      ALL_PATHS.map((path) => ({ path, baseBlobSha: SHAS[path as keyof typeof SHAS], baseContent: "" })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps confirm disabled and surfaces an error when enumeration fails", async () => {
    mockEnumerate.mockResolvedValue({
      data: { status: "git_error", message: "boom" },
    });
    const onStage = vi.fn();

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "skill", skillDir: SKILL_DIR }}
        onStage={onStage}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("delete-error").textContent).toContain("boom"),
    );
    expect(screen.getByTestId("delete-confirm")).toBeDisabled();
    expect(onStage).not.toHaveBeenCalled();
  });

  it("omits an enumerated path from staging when the live listing carried no sha for it", async () => {
    const noShaPath = `${SKILL_DIR}/scripts/run.sh`;
    mockEnumerate.mockResolvedValue({
      data: {
        status: "ok",
        enumeration: {
          paths: [CONTENT_PATHS[0]!, noShaPath],
          assetPaths: [noShaPath],
          shas: { [CONTENT_PATHS[0]!]: "sha-skill" },
        },
      },
    });
    const onStage = vi.fn();

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "skill", skillDir: SKILL_DIR }}
        onStage={onStage}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("delete-confirm")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("delete-confirm"));

    expect(onStage).toHaveBeenCalledWith([
      { path: CONTENT_PATHS[0]!, baseBlobSha: "sha-skill", baseContent: "" },
    ]);
  });
});

describe("DeleteContextDialog — single file", () => {
  it("does not enumerate and stages just the one path with its pinned sha and loaded content", () => {
    const onStage = vi.fn();
    const onClose = vi.fn();
    const path = `${SKILL_DIR}/references/notes.md`;

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "file", path, baseBlobSha: "sha-notes", content: "# Notes\n" }}
        onStage={onStage}
        onClose={onClose}
      />,
    );

    expect(mockEnumerate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("delete-confirm"));

    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage).toHaveBeenCalledWith([{ path, baseBlobSha: "sha-notes", baseContent: "# Notes\n" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DeleteContextDialog — generic folder", () => {
  it("titles the dialog for a folder (not a skill) and stages every enumerated path", async () => {
    const DIR = ".outerlayer/docs/guides";
    const notePath = `${DIR}/setup.md`;
    mockEnumerate.mockResolvedValue({
      data: {
        status: "ok",
        enumeration: { paths: [notePath], assetPaths: [], shas: { [notePath]: "sha-note" } },
      },
    });
    const onStage = vi.fn();

    render(
      <DeleteContextDialog
        open
        appId="app-1"
        target={{ kind: "dir", dirPath: DIR }}
        onStage={onStage}
        onClose={vi.fn()}
      />,
    );

    expect(mockEnumerate).toHaveBeenCalledWith("app-1", DIR);
    expect(screen.getByText("Delete this folder?")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("delete-confirm")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("delete-confirm"));

    expect(onStage).toHaveBeenCalledWith([{ path: notePath, baseBlobSha: "sha-note", baseContent: "" }]);
  });
});
