import test from "node:test";
import assert from "node:assert/strict";
import { documentSessions } from "../src/pdf-sessions.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;

test("shares documents, pins active users, and evicts idle sessions", async () => {
  const opened = [],
    closed = [];
  const run = documentSessions((key) => {
    opened.push(key);
    return {
      ready: Promise.resolve(key),
      close: async () => {
        closed.push(key);
      },
    };
  });
  const hold = deferred();
  const first = run("a", signal(), () => hold.promise);
  await tick();
  await run("a", signal(), () => {});
  await run("b", signal(), () => {});
  await run("c", signal(), () => {});
  assert.deepEqual(opened, ["a", "b", "c"]);
  assert.deepEqual(closed, ["b"]);
  hold.resolve();
  await first;
  await run("d", signal(), () => {});
  assert.deepEqual(closed, ["b", "a"]);
});

test("cancelled queued work never loads a document", async () => {
  const opened = [];
  const run = documentSessions((key) => {
    opened.push(key);
    return { ready: Promise.resolve(key), close: async () => {} };
  });
  const hold = deferred();
  const active = [
    run("a", signal(), () => hold.promise),
    run("b", signal(), () => hold.promise),
  ];
  await tick();
  const controller = new AbortController();
  const pending = run("c", controller.signal, () =>
    assert.fail("cancelled work ran"),
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  hold.resolve();
  await Promise.all(active);
  assert.deepEqual(opened, ["a", "b"]);
});

test("abandoned loads close even when their ready promise completes later", async () => {
  const ready = deferred();
  let closed = 0,
    opened = 0;
  const run = documentSessions(() => {
    opened++;
    return {
      ready: opened === 1 ? ready.promise : Promise.resolve("new"),
      close: async () => {
        closed++;
      },
    };
  });
  const controller = new AbortController();
  const pending = run("a", controller.signal, () =>
    assert.fail("abandoned load ran"),
  );
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(closed, 1);
  ready.resolve("old");
  assert.equal(await run("a", signal(), (source) => source), "new");
  assert.equal(opened, 2);
});

test("cancelling one consumer does not destroy a shared load", async () => {
  const ready = deferred();
  let closed = 0;
  const run = documentSessions(() => ({
    ready: ready.promise,
    close: async () => {
      closed++;
    },
  }));
  const controller = new AbortController();
  const first = run("a", controller.signal, () => assert.fail());
  const second = run("a", signal(), (source) => source);
  await tick();
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(closed, 0);
  ready.resolve("shared");
  assert.equal(await second, "shared");
});

test("failed loads close and retry with a fresh session", async () => {
  let opened = 0,
    closed = 0;
  const run = documentSessions(() => ({
    ready:
      ++opened === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve("ok"),
    close: async () => {
      closed++;
    },
  }));
  await assert.rejects(
    run("a", signal(), () => {}),
    /offline/,
  );
  assert.equal(await run("a", signal(), (source) => source), "ok");
  assert.equal(closed, 1);
});
