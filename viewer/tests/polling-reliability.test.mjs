import test from "node:test";
import assert from "node:assert/strict";
import {
  isTransientOrganizationPollingFailure,
  startOrganizationPolling,
} from "../lib/organization-polling-lifecycle.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

const flush = async (turns = 8) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const status = (value) => ({
  status: value,
  stage: "classify",
  completed: value === "complete" ? 1 : 0,
  total: 1,
  percent: value === "complete" ? 100 : 0,
  documentCount: 1,
  warnings: [],
});

const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

function pollingHarness({
  currentStageId = "organize",
  responses = [status("complete")],
  shared = {},
} = {}) {
  const requests = [];
  const statuses = shared.statuses ||= [];
  const errors = shared.errors ||= [];
  let documents = 0;
  let workflowCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const stop = startOrganizationPolling({
    currentStageId,
    loadWorkflow: async () => {
      workflowCalls += 1;
      return { currentStageId };
    },
    requestOrganization: (init) => {
      requests.push(init);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const next = responses.shift();
      const result = typeof next === "function" ? next(init) : next;
      return (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
        .finally(() => { inFlight -= 1; });
    },
    loadDocuments: async () => { documents += 1; },
    onStatus: (next) => statuses.push(next.status),
    onError: (message) => errors.push(message),
    onRecovered: () => { shared.recoveries = (shared.recoveries || 0) + 1; },
  });
  return {
    stop,
    requests,
    statuses,
    errors,
    get documents() { return documents; },
    get workflowCalls() { return workflowCalls; },
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
  };
}

const assertBodylessGets = (requests) => {
  assert.ok(requests.length > 0);
  assert.ok(requests.every((init) => init.method === "GET" && !("body" in init)));
};

test("running Organization observation uses bodyless GETs on a settled cadence and refreshes once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = pollingHarness({ responses: [status("running"), status("complete")] });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(harness.requests.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.statuses, ["running", "complete"]);
  assert.equal(harness.documents, 1);
  assert.equal(harness.workflowCalls, 1);
  assert.equal(harness.maxInFlight, 1);
  assertBodylessGets(harness.requests);
});

test("empty Organization observation is terminal and refreshes once", async () => {
  const harness = pollingHarness({ responses: [status("empty")] });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.documents, 1);
  assert.equal(harness.workflowCalls, 1);
});

test("a slow Organization observation remains single-flight and schedules only after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const harness = pollingHarness({ responses: [status("running"), () => pending.promise] });
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(harness.inFlight, 1);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.maxInFlight, 1);
  pending.resolve(status("running"));
  await flush();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(harness.requests.length, 2);
  harness.stop();
});

test("cleanup clears a pending timer and aborts an in-flight observation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = pollingHarness({ responses: [status("running"), status("complete")] });
  await flush();
  waiting.stop();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(waiting.requests.length, 1);

  const pending = deferred();
  const active = pollingHarness({ responses: [() => pending.promise] });
  await flush();
  active.stop();
  assert.equal(active.requests[0].signal.aborted, true);
  pending.resolve(status("complete"));
  await flush();
  assert.deepEqual(active.statuses, []);
  assert.equal(active.documents, 0);
});

test("a replacement generation cannot be overwritten by a stale response", async () => {
  const pending = deferred();
  const shared = {};
  const old = pollingHarness({ responses: [() => pending.promise], shared });
  await flush();
  old.stop();
  const next = pollingHarness({ responses: [status("complete")], shared });
  await flush();
  pending.resolve(status("running"));
  await flush();
  assert.deepEqual(shared.statuses, ["complete"]);
  assert.equal(next.documents, 1);
});

test("transient failure retries once, then recovers and clears its error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shared = {};
  const harness = pollingHarness({ responses: [failure("offline"), status("complete")], shared });
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.statuses, ["complete"]);
  assert.equal(harness.errors.length, 1);
  assert.equal(shared.recoveries, 1);
  assertBodylessGets(harness.requests);
});

test("retry exhaustion stops after three bounded retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = pollingHarness({ responses: [failure("one"), failure("two"), failure("three"), failure("four")] });
  await flush();
  for (const delay of [500, 1000, 2000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(harness.requests.length, 4);
  assert.equal(harness.errors.length, 4);
});

test("only network, retryable timeout/rate-limit, and server failures retry", () => {
  for (const value of [failure("network"), failure("408", { status: 408 }), failure("425", { status: 425 }), failure("429", { status: 429 }), failure("500", { status: 500 })]) {
    assert.equal(isTransientOrganizationPollingFailure(value), true);
  }
  for (const value of [failure("400", { status: 400 }), failure("invalid", { retryable: false })]) {
    assert.equal(isTransientOrganizationPollingFailure(value), false);
  }
});

test("a non-transient 400 shows safe observation copy and stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = pollingHarness({ responses: [failure("Organization status could not be observed", { status: 400 })] });
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.errors, ["Organization status could not be observed"]);
});

test("the hydrated workflow stage decides whether Organization is observed", async () => {
  for (const currentStageId of ["collect", "privacy", "story", "review", "handoff"]) {
    const harness = pollingHarness({ currentStageId });
    await flush();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.workflowCalls, 0);
  }
});
