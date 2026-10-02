import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireAvatar, isInstagramPhoto } from "../src/avatars";

const photo = "https://scontent-test.cdninstagram.com/photo.jpg?signature=test";
test("photo host permission checks reject unrelated domains and embedded credentials", () => {
  assert.ok(isInstagramPhoto(photo));
  assert.ok(isInstagramPhoto("https://scontent.fbcdn.net/photo.jpg"));
  for (const url of [
    "http://scontent.cdninstagram.com/photo.jpg",
    "https://cdninstagram.com.evil.test/photo.jpg",
    "https://cdninstagram.com@evil.test/photo.jpg",
    "https://secret@scontent.cdninstagram.com/photo.jpg",
    "not a URL",
  ])
    assert.equal(isInstagramPhoto(url), false);
});
test("shared photos use one credential-free fetch; blob URLs remain valid until the last consumer releases", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, photo);
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.referrerPolicy, "no-referrer");
    return new Response(new Blob(["test"], { type: "image/png" }));
  };
  const a = acquireAvatar(photo),
    b = acquireAvatar(photo);
  try {
    const src = await a.ready;
    assert.equal(await b.ready, src);
    assert.ok(src.startsWith("blob:"));
    assert.equal(calls, 1);
    a.release();
    a.release();
    assert.equal(await (await originalFetch(src)).text(), "test");
    b.release();
    await assert.rejects(originalFetch(src));
  } finally {
    a.release();
    b.release();
    globalThis.fetch = originalFetch;
  }
});
test("expired URLs and non-image responses fail cleanly and can be retried after release", async () => {
  const originalFetch = globalThis.fetch;
  let a: ReturnType<typeof acquireAvatar> | undefined;
  try {
    globalThis.fetch = async () => new Response("Expired", { status: 403 });
    a = acquireAvatar(photo);
    await assert.rejects(a.ready, /unavailable/);
    a.release();
    globalThis.fetch = async () =>
      new Response("<html>login</html>", {
        headers: { "Content-Type": "text/html" },
      });
    a = acquireAvatar(photo);
    await assert.rejects(a.ready, /Invalid photo/);
    a.release();
    globalThis.fetch = async () =>
      new Response(new Blob(["test"], { type: "image/jpeg" }));
    a = acquireAvatar(photo);
    assert.ok((await a.ready).startsWith("blob:"));
  } finally {
    a?.release();
    globalThis.fetch = originalFetch;
  }
});
test("changing a profile during a fetch cancels the old image and creates no abandoned blob URL", async () => {
  const originalFetch = globalThis.fetch;
  let respond!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Promise((resolve) => {
      respond = resolve;
    });
  };
  const a = acquireAvatar(photo);
  try {
    const rejection = assert.rejects(a.ready, /Invalid photo/);
    a.release();
    assert.equal(signal?.aborted, true);
    respond(new Response(new Blob(["test"], { type: "image/png" })));
    await rejection;
  } finally {
    a.release();
    globalThis.fetch = originalFetch;
  }
});
