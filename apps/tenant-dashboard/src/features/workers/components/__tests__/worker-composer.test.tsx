// @vitest-environment jsdom
/**
 * The chat composer: Enter submits, Shift+Enter is a newline, whitespace-only
 * input never submits, busy/disabled states block both keyboard and the send
 * button, and file attachments are picked, capped, chip-rendered, and
 * removable.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_WORKER_ATTACHMENT_BYTES } from "@repo/worker-core";

import {
  WorkerComposer,
  formatAttachmentSize,
  readFileAsAttachment,
  selectAttachmentFiles,
  type ComposerAttachment,
} from "../worker-composer";

function setup(over: Partial<React.ComponentProps<typeof WorkerComposer>> = {}) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const props = {
    value: "",
    onChange,
    onSubmit,
    placeholder: "Describe a task",
    ...over,
  };
  render(<WorkerComposer {...props} />);
  return { onSubmit, onChange, input: screen.getByPlaceholderText("Describe a task") };
}

describe("WorkerComposer", () => {
  it("submits on Enter when there is text", async () => {
    const { onSubmit, input } = setup({ value: "do the thing" });
    await userEvent.type(input, "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter (newline)", async () => {
    const { onSubmit, input } = setup({ value: "do the thing" });
    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on Enter when the value is whitespace-only", async () => {
    const { onSubmit, input } = setup({ value: "   " });
    await userEvent.type(input, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while busy, and shows a spinner instead of the send icon", async () => {
    const { onSubmit, input } = setup({ value: "do the thing", busy: true });
    await userEvent.type(input, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("disables the input entirely when disabled", () => {
    const { input } = setup({ value: "", disabled: true });
    expect(input).toBeDisabled();
  });

  it("sends via the button and reports typed input through onChange", async () => {
    const { onSubmit, onChange, input } = setup({ value: "ship it" });
    await userEvent.type(input, "!");
    expect(onChange).toHaveBeenCalledWith("ship it!");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the send button when the value is empty", () => {
    setup({ value: "" });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("renders caller-provided controls in the bottom bar", () => {
    setup({ controls: <span data-testid="agent-picker" /> });
    expect(screen.getByTestId("agent-picker")).toBeInTheDocument();
  });
});

function attachment(over: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: "att-1",
    name: "shot.png",
    mime: "image/png",
    sizeBytes: 4,
    content: "aGVsbA==",
    ...over,
  };
}

describe("WorkerComposer attachments", () => {
  it("hides the paperclip when the caller does not manage attachments", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
  });

  it("encodes a picked file to base64 and reports it through onAttachmentsChange", async () => {
    const onAttachmentsChange = vi.fn();
    setup({ attachments: [], onAttachmentsChange });

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByTestId("worker-attachment-input"), file);

    await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledTimes(1));
    const [added] = onAttachmentsChange.mock.calls[0]![0] as ComposerAttachment[];
    expect(added).toMatchObject({
      name: "notes.txt",
      mime: "text/plain",
      sizeBytes: 5,
      content: Buffer.from("hello").toString("base64"),
    });
  });

  it("renders selected attachments as chips with name and size, and removes on X", async () => {
    const onAttachmentsChange = vi.fn();
    setup({
      attachments: [attachment({ id: "keep", name: "a.png" }), attachment({ id: "drop", name: "b.pdf", mime: "application/pdf" })],
      onAttachmentsChange,
    });

    expect(screen.getByText("a.png · 4 B")).toBeInTheDocument();
    expect(screen.getByText("b.pdf · 4 B")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Remove b.pdf"));
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "keep", name: "a.png" }),
    ]);
  });

  it("reports an error and keeps state unchanged when a picked file is over the per-file cap", async () => {
    const onAttachmentsChange = vi.fn();
    const onAttachmentError = vi.fn();
    setup({ attachments: [], onAttachmentsChange, onAttachmentError });

    const big = new File([new Uint8Array(MAX_WORKER_ATTACHMENT_BYTES + 1)], "huge.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("worker-attachment-input"), big);

    await waitFor(() =>
      expect(onAttachmentError).toHaveBeenCalledWith(
        `huge.png is larger than the ${formatAttachmentSize(MAX_WORKER_ATTACHMENT_BYTES)} per-file limit.`,
      ),
    );
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});

describe("selectAttachmentFiles", () => {
  const png = (name: string, bytes: number, type = "image/png") =>
    new File([new Uint8Array(bytes)], name, { type });

  it("rejects the fifth file by count while accepting the rest", () => {
    const existing = [attachment({ id: "1" }), attachment({ id: "2" }), attachment({ id: "3" })];
    const { accepted, error } = selectAttachmentFiles(existing, [png("d.png", 8), png("e.png", 8)]);
    expect(accepted.map((f) => f.name)).toEqual(["d.png"]);
    expect(error).toBe("You can attach at most 4 files.");
  });

  it("rejects video files by type", () => {
    const { accepted, error } = selectAttachmentFiles([], [png("clip.mp4", 8, "video/mp4")]);
    expect(accepted).toEqual([]);
    expect(error).toBe("clip.mp4: this file type is not supported.");
  });

  it("enforces the running total across existing and newly picked files", () => {
    const existing = [attachment({ id: "1", sizeBytes: 2_500_000 })];
    const { accepted, error } = selectAttachmentFiles(existing, [png("more.png", 1_000_000)]);
    expect(accepted).toEqual([]);
    expect(error).toContain("limited to");
  });
});

describe("readFileAsAttachment", () => {
  it("produces base64 content and a stable name/mime/size triple", async () => {
    const read = await readFileAsAttachment(new File(["abc"], "a.md", { type: "text/markdown" }));
    expect(read).toMatchObject({
      name: "a.md",
      mime: "text/markdown",
      sizeBytes: 3,
      content: Buffer.from("abc").toString("base64"),
    });
  });

  it("falls back to application/octet-stream for files with no browser mime", async () => {
    const read = await readFileAsAttachment(new File(["x"], "trace.log", { type: "" }));
    expect(read.mime).toBe("application/octet-stream");
  });
});
