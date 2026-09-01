import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStoryReviewSession } from "../lib/story-review-session.ts";

const persistenceModule = await import("../lib/story-review-session-persistence.ts")
  .catch((importError) => ({ importError }));

function persistenceContract() {
  assert.equal(persistenceModule.importError, undefined, "single-flight review-session persistence helper must exist");
  return persistenceModule;
}

const session = (label) => {
  const value = createStoryReviewSession("review-run", {}, {});
  value.privacyDecisions = label ? { [JSON.stringify(["chapter", label])]: "keep" } : {};
  return value;
};

const storySession = () => createStoryReviewSession("review-run", {}, {});

class ManualScheduler {
  nextId = 1;
  tasks = new Map();
  setTimeout = (callback) => {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id;
  };
  clearTimeout = (id) => { this.tasks.delete(id); };
  runAll() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

const saved = (serverVersion) => ({
  saved: true, noChange: false, serverVersion, sourceRevision: 1,
  persistedAt: `2035-01-01T00:00:0${serverVersion}.000Z`,
});

test("revision zero initialization fails before queue, scheduler, status, or save mutation", () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  let saves = 0;
  const statuses = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async () => { saves += 1; return saved(1); },
    scheduler,
    onStatus: (state) => statuses.push(state),
  });
  const before = queue.getState();
  assert.throws(() => queue.initialize({
    workflowRunId: "review-run", serverVersion: 0, sourceRevision: 0, session: null,
  }), /STORY_SESSION_STATE_INVALID/);
  assert.deepEqual(queue.getState(), before);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(statuses.length, 0);
  assert.equal(saves, 0);

  queue.initialize({
    workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null,
  });
  assert.equal(queue.getState().status, "durable");
  assert.equal(queue.getState().serverVersion, 0);
  assert.equal(queue.getState().sourceRevision, 1);
});

test("debounce coalesces local changes into one latest POST", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const calls = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async (request) => { calls.push(request); return saved(1); },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  queue.schedule(session("a"));
  queue.schedule(session("b"));
  queue.schedule(session("c"));
  scheduler.runAll();
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].session.privacyDecisions, session("c").privacyDecisions);
});

test("the canonical session uses the exact single-flight queue", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const calls = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async (request) => { calls.push(request); return saved(1); },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  queue.schedule(storySession());
  scheduler.runAll();
  await queue.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session.schema, "oxygen.story-review-session");
  assert.equal(queue.isDurable(storySession()), true);
});

test("one write is in flight and an edit queues one later write with acknowledged version", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const first = deferred();
  const calls = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: (request) => {
      calls.push(request);
      return calls.length === 1 ? first.promise : Promise.resolve(saved(2));
    },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  queue.schedule(session("a"));
  scheduler.runAll();
  queue.schedule(session("b"));
  scheduler.runAll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedVersion, 0);
  first.resolve(saved(1));
  await queue.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedVersion, 1);
  assert.equal(queue.getState().status, "durable");
  assert.equal(queue.isDurable(session("b")), true);
});

test("acknowledgement applies only to the exact sent snapshot", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const first = deferred();
  const queue = new StoryReviewSessionPersistenceQueue({ save: () => first.promise, scheduler });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  queue.schedule(session("a"));
  scheduler.runAll();
  queue.schedule(session("b"));
  first.resolve(saved(1));
  await Promise.resolve();
  assert.equal(queue.isDurable(session("a")), true);
  assert.equal(queue.isDurable(session("b")), false);
  assert.notEqual(queue.getState().status, "durable");
});

test("a fixed conflict stops automatic persistence without silent retry", async () => {
  const { StoryReviewSessionPersistenceQueue, StoryReviewSessionPersistenceError } = persistenceContract();
  const scheduler = new ManualScheduler();
  let calls = 0;
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async () => {
      calls += 1;
      throw new StoryReviewSessionPersistenceError("STORY_SESSION_VERSION_CONFLICT");
    },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 4, sourceRevision: 1, session: session("base") });
  queue.schedule(session("stale"));
  scheduler.runAll();
  await assert.rejects(queue.flush(), /STORY_SESSION_VERSION_CONFLICT/);
  queue.schedule(session("later"));
  scheduler.runAll();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(queue.getState().status, "conflict");
});

test("network failure is not silently converted into a new-version retry", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  let calls = 0;
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async () => { calls += 1; throw new Error("network unavailable"); },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  queue.schedule(session("a"));
  scheduler.runAll();
  await assert.rejects(queue.flush(), /network unavailable/);
  assert.equal(calls, 1);
  assert.equal(queue.getState().status, "failed");
});

test("no-op acknowledgement leaves the exact snapshot durable", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async () => ({
      saved: false, noChange: true, serverVersion: 2, sourceRevision: 1,
      persistedAt: "2035-01-01T00:00:02.000Z",
    }),
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 2, sourceRevision: 1, session: session("same") });
  const same = session("same");
  queue.schedule(same);
  await queue.flush();
  assert.equal(queue.isDurable(same), true);
  assert.equal(queue.getState().serverVersion, 2);
});

test("source invalidation enters conflict and ignores an old in-flight acknowledgement", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const first = deferred();
  const queue = new StoryReviewSessionPersistenceQueue({ save: () => first.promise, scheduler });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 1, sourceRevision: 1, session: session("r1") });
  queue.schedule(session("old"));
  scheduler.runAll();
  queue.invalidate();
  first.resolve(saved(2));
  await Promise.resolve();
  assert.equal(queue.getState().status, "conflict");
  assert.equal(queue.getState().sourceRevision, null);
});

test("source reinitialization retains physical single-flight until the old request settles", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const first = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const queue = new StoryReviewSessionPersistenceQueue({
    save: (request) => {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = calls.length === 1
        ? first.promise
        : Promise.resolve({ ...saved(6), sourceRevision: 2 });
      return result.finally(() => { active -= 1; });
    },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 1, sourceRevision: 1, session: session("r1") });
  queue.schedule(session("old"));
  scheduler.runAll();
  queue.invalidate();
  queue.initialize({ workflowRunId: "review-run", serverVersion: 5, sourceRevision: 2, session: null });
  const barrier = queue.flush(session("fresh"));
  assert.equal(calls.length, 1);
  assert.equal(active, 1);
  first.resolve(saved(2));
  await barrier;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedVersion, 5);
  assert.equal(calls[1].sourceRevision, 2);
  assert.equal(maxActive, 1);
  assert.equal(queue.isDurable(session("fresh")), true);
});

test("refresh metadata initializes the exact version used by the next write", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const calls = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async (request) => {
      calls.push(request);
      return { ...saved(8), sourceRevision: 3 };
    },
    scheduler,
  });
  queue.initialize({
    workflowRunId: "review-run", serverVersion: 7, sourceRevision: 3,
    session: session("persisted"), persistedAt: "2035-01-01T00:00:07.000Z",
  });
  queue.schedule(session("next"));
  scheduler.runAll();
  await queue.flush();
  assert.equal(calls[0].expectedVersion, 7);
  assert.equal(calls[0].sourceRevision, 3);
  assert.equal(queue.getState().serverVersion, 8);
});

test("handoff flush waits through the latest queued acknowledgement before invoking handoff", async () => {
  const { StoryReviewSessionPersistenceQueue, runDurableStoryReviewHandoff } = persistenceContract();
  const scheduler = new ManualScheduler();
  const first = deferred();
  const second = deferred();
  const calls = [];
  const queue = new StoryReviewSessionPersistenceQueue({
    save: (request) => {
      calls.push(request);
      return calls.length === 1 ? first.promise : second.promise;
    },
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  let current = session("a");
  queue.schedule(current);
  let handoffCalls = 0;
  let authority = null;
  const barrier = runDurableStoryReviewHandoff({
    persistence: queue,
    currentSession: () => current,
    handoff: async (value) => { authority = value; handoffCalls += 1; return "released"; },
  });
  current = session("b");
  queue.schedule(current);
  first.resolve(saved(1));
  await Promise.resolve();
  let completed = false;
  void barrier.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(handoffCalls, 0);
  second.resolve(saved(2));
  assert.equal(await barrier, "released");
  assert.equal(handoffCalls, 1);
  assert.equal(queue.isDurable(session("b")), true);
  assert.deepEqual(authority, {
    workflowRunId: "review-run",
    serverVersion: 2,
    sourceRevision: 1,
  });
});

for (const [name, failure] of [
  ["failed save", new Error("network unavailable")],
  ["version conflict", new persistenceModule.StoryReviewSessionPersistenceError("STORY_SESSION_VERSION_CONFLICT")],
]) {
  test(`${name} blocks the handoff action`, async () => {
    const { StoryReviewSessionPersistenceQueue, runDurableStoryReviewHandoff } = persistenceContract();
    const scheduler = new ManualScheduler();
    const queue = new StoryReviewSessionPersistenceQueue({ save: async () => { throw failure; }, scheduler });
    queue.initialize({ workflowRunId: "review-run", serverVersion: 1, sourceRevision: 1, session: session("base") });
    let handoffCalls = 0;
    await assert.rejects(runDurableStoryReviewHandoff({
      persistence: queue,
      currentSession: () => session("next"),
      handoff: async () => { handoffCalls += 1; },
    }));
    assert.equal(handoffCalls, 0);
  });
}

test("an impossible acknowledgement cannot mark a snapshot durable", async () => {
  const { StoryReviewSessionPersistenceQueue } = persistenceContract();
  const scheduler = new ManualScheduler();
  const queue = new StoryReviewSessionPersistenceQueue({
    save: async () => ({ ...saved(9), persistedAt: "" }),
    scheduler,
  });
  queue.initialize({ workflowRunId: "review-run", serverVersion: 0, sourceRevision: 1, session: null });
  await assert.rejects(queue.flush(session("a")), /STORY_SESSION_STATE_INVALID/);
  assert.equal(queue.isDurable(session("a")), false);
  assert.equal(queue.getState().status, "failed");
});

test("Workspace routes both HTML and ZIP through the durable-save barrier", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  const handoff = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(handoff, /runDurableStoryReviewHandoff/);
  assert.ok(handoff.indexOf("runDurableStoryReviewHandoff") < handoff.indexOf("fetch(url"));
  assert.match(handoff, /workflowRunId/);
  assert.match(handoff, /serverVersion/);
  assert.match(handoff, /sourceRevision/);
  assert.doesNotMatch(handoff, /reviewedStory/);
  assert.match(workspace, /downloadReviewed\("download_html","\/api\/organization\/export"/);
  assert.match(workspace, /downloadReviewed\("download_zip","\/api\/package"/);
});
