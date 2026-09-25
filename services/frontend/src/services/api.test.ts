import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop/bridge";

// api.ts resolves the desktop pairing token once, at import time, from `window.katharaDesktop`.
// Every test therefore sets up `window` first and then imports a fresh copy of the module.
async function loadApi(opts: { shell?: Partial<DesktopApi>; protocol?: string } = {}) {
  vi.resetModules();
  vi.stubGlobal("window", {
    katharaDesktop: opts.shell,
    location: { protocol: opts.protocol ?? "http:", host: "127.0.0.1:41234" },
  });
  return import("./api");
}

let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(body: BodyInit | null, init: ResponseInit = {}) {
  fetchMock.mockImplementation(async () => new Response(body, init));
}

function lastCall(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requests", () => {
  it("sends a JSON body with its content type, under /api", async () => {
    const { api } = await loadApi();

    await api.renameLab("old", "new");

    const { url, init } = lastCall();
    expect(url).toBe("/api/labs/old/rename");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"name":"new"}');
  });

  it("sends no body and no content type when there is nothing to send", async () => {
    const { api } = await loadApi();

    await api.listLabs();

    const { init } = lastCall();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  it("forwards the abort signal to fetch", async () => {
    const { api } = await loadApi();
    const controller = new AbortController();

    await api.getLab("l", controller.signal);

    expect(lastCall().init.signal).toBe(controller.signal);
  });

  it("URL-encodes lab names, device names and paths", async () => {
    const { api } = await loadApi();

    await api.getLab("my lab/1");
    expect(lastCall().url).toBe("/api/labs/my%20lab%2F1");

    await api.fsReadText("l", "pc 1", "/tmp/a b&c=d");
    expect(lastCall().url).toBe("/api/labs/l/machines/pc%201/fs/text?path=%2Ftmp%2Fa%20b%26c%3Dd");

    await api.fsSearchOffline("l", "/", "ip a&b", true);
    expect(lastCall().url).toBe("/api/labs/l/fs/search?path=%2F&query=ip%20a%26b&case_sensitive=true");
  });

  it("puts connect options in the query string only when they are given", async () => {
    const { api } = await loadApi();

    await api.connectMachine("l", "pc1", "A");
    expect(lastCall().url).toBe("/api/labs/l/machines/pc1/connect?link=A");

    await api.connectMachine("l", "pc1", "A", 0, "02:42:ac:11:00:02");
    expect(lastCall().url).toBe(
      "/api/labs/l/machines/pc1/connect?link=A&interface_number=0&mac_address=02%3A42%3Aac%3A11%3A00%3A02",
    );
  });

  it("sends an install's target name only when one is chosen", async () => {
    const { api } = await loadApi();

    await api.createExampleLab("basic");
    expect(lastCall().init.body).toBe('{"id":"basic"}');

    await api.createGalleryLab("main-labs/ospf", "my-ospf");
    expect(lastCall().init.body).toBe('{"id":"main-labs/ospf","name":"my-ospf"}');
  });

  it("uploads multipart without a content type of its own, trimming the optional name", async () => {
    const { api } = await loadApi();
    const file = new File(["PK"], "lab.zip");

    await api.uploadLab(file, "  mylab ");
    const named = lastCall();
    expect(named.url).toBe("/api/labs/upload");
    expect(named.init.headers).not.toHaveProperty("Content-Type");
    expect((named.init.body as FormData).get("name")).toBe("mylab");
    expect((named.init.body as FormData).get("file")).toBeInstanceOf(File);

    await api.uploadLab(file, "   ");
    expect((lastCall().init.body as FormData).has("name")).toBe(false);
  });
});

describe("responses", () => {
  it("parses a JSON body", async () => {
    const { api } = await loadApi();
    respondWith('[{"name":"l"}]');

    await expect(api.listLabs()).resolves.toEqual([{ name: "l" }]);
  });

  it("returns null for an empty body and the raw text for a non-JSON one", async () => {
    const { api } = await loadApi();

    respondWith(null, { status: 200 });
    await expect(api.health()).resolves.toBeNull();

    respondWith("ok", { status: 200 });
    await expect(api.health()).resolves.toBe("ok");
  });

  it("returns a binary download as a Blob", async () => {
    const { api } = await loadApi();
    respondWith(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });

    const blob = await api.downloadLab("l");

    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  });
});

describe("errors", () => {
  it("turns the backend's error body into an ApiError", async () => {
    const { api, ApiError } = await loadApi();
    respondWith('{"detail":"Lab `l` not found.","error_type":"LabNotFoundError"}', { status: 404 });

    const err = await api.getLab("l").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: "Lab `l` not found.", errorType: "LabNotFoundError", status: 404 });
  });

  it("joins a list of validation messages into one", async () => {
    const { api } = await loadApi();
    respondWith('{"detail":[{"msg":"field required"},{"loc":["body"]},{"msg":"not a string"}]}', {
      status: 422,
    });

    await expect(api.getLab("l")).rejects.toMatchObject({
      message: "field required; not a string",
      errorType: "HTTP 422",
      status: 422,
    });
  });

  it("falls back to the status text, then to the status code", async () => {
    const { api } = await loadApi();

    respondWith("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    await expect(api.listLabs()).rejects.toMatchObject({ message: "Bad Gateway", errorType: "HTTP 502" });

    respondWith(null, { status: 500 });
    await expect(api.listLabs()).rejects.toMatchObject({ message: "HTTP 500", errorType: "HTTP 500" });
  });

  it("reports a failed binary download the same way", async () => {
    const { api } = await loadApi();
    respondWith('{"detail":"Path `/x` not found.","error_type":"PathNotFoundError"}', { status: 404 });

    await expect(api.fsDownloadOffline("l", "/x")).rejects.toMatchObject({
      message: "Path `/x` not found.",
      errorType: "PathNotFoundError",
    });
  });
});

describe("the desktop pairing token", () => {
  it("is sent as a bearer token on every request and as ?token= on streams", async () => {
    const { api } = await loadApi({ shell: { getAuthToken: async () => "s3cr et" }, protocol: "https:" });

    await api.listLabs();
    expect(lastCall().init.headers.Authorization).toBe("Bearer s3cr et");

    await api.uploadLab(new File(["PK"], "lab.zip"));
    expect(lastCall().init.headers.Authorization).toBe("Bearer s3cr et");

    expect(api.ttyWsUrl("my lab", "pc1", "zsh")).toBe(
      "wss://127.0.0.1:41234/api/labs/my%20lab/machines/pc1/tty/ws?shell=zsh&token=s3cr%20et",
    );
    expect(api.statsStreamUrl("l")).toBe("/api/labs/l/stats/stream?token=s3cr%20et");
  });

  it("is simply left out when the shell fails to provide one", async () => {
    const { api } = await loadApi({ shell: { getAuthToken: async () => Promise.reject(new Error("ipc down")) } });

    await api.listLabs();

    expect(lastCall().init.headers).not.toHaveProperty("Authorization");
    expect(api.statsStreamUrl("l")).toBe("/api/labs/l/stats/stream");
  });

  it("is absent in the browser build", async () => {
    const { api } = await loadApi();

    await api.listLabs();

    expect(lastCall().init.headers).not.toHaveProperty("Authorization");
    expect(api.ttyWsUrl("l", "pc1")).toBe("ws://127.0.0.1:41234/api/labs/l/machines/pc1/tty/ws?shell=bash");
  });
});

describe("isAbortError", () => {
  it("recognizes only the rejection an aborted fetch produces", async () => {
    const { isAbortError } = await loadApi();

    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("nope", "NotFoundError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
