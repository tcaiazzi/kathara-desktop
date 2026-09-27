import { describe, expect, it, vi } from "vitest";
import type { FsTreeSource } from "../hooks/useFsTree";
import { withChangeNotice } from "./labFilesSync";

function fakeSource(fail = false): FsTreeSource {
  const op = vi.fn(async () => {
    if (fail) throw new Error("refused");
  });
  return {
    list: vi.fn(async () => []),
    readText: vi.fn(async () => ""),
    writeText: op,
    mkdir: op,
    move: op,
    copy: op,
    remove: op,
    upload: op,
    labels: {} as FsTreeSource["labels"],
  };
}

describe("withChangeNotice", () => {
  it("announces every operation that changes the disk, after it succeeds", async () => {
    const notify = vi.fn();
    const source = withChangeNotice(fakeSource(), notify);
    await source.writeText("/a", "x");
    await source.mkdir("/d");
    await source.move("/a", "/b");
    await source.copy("/b", "/c");
    await source.remove("/c");
    await source.upload("/u", new Blob() as File);
    expect(notify).toHaveBeenCalledTimes(6);
  });

  it("stays quiet for reads and for an operation that fails", async () => {
    const notify = vi.fn();
    const source = withChangeNotice(fakeSource(true), notify);
    await source.list("/");
    await source.readText("/a");
    await expect(source.writeText("/a", "x")).rejects.toThrow("refused");
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes the arguments through to the wrapped operation", async () => {
    const inner = fakeSource();
    await withChangeNotice(inner, () => {}).move("/from", "/to");
    expect(inner.move).toHaveBeenCalledWith("/from", "/to");
  });
});
