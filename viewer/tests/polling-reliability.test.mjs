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
  workflow = { currentStageId: "organize" },
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
    loadWorkflow: async () => {
      workflowCalls += 1;
      return workflow;
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

test("transient failure retries once, then recovers and clears its error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shared = {};
  const harness = pollingHarness({ responses: [failure("offline"), status("complete")], shared });
  await flush();
  assert.equal(harness.requests.length, 1);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.statuses, ["complete"]);
  assert.equal(harness.errors.length, 1);
  assert.equal(shared.recoveries, 1);
});

test("retry exhaustion stops after three bounded retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = pollingHarness({ responses: [failure("one"), failure("two"), failure("three"), failure("four")] });
  await flush();
  for (const delay of [500, 1000, 2000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
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

test("non-transient Organization failures stop without retry", async () => {
  const harness = pollingHarness({ responses: [failure("bad request", { status: 400 })] });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.errors.length, 1);
});

test("cleanup aborts an in-flight request and suppresses its later result", async () => {
  const pending = deferred();
  const harness = pollingHarness({ responses: [status("running"), () => pending.promise] });
  await flush();
  await flush();
  assert.equal(harness.requests.length, 2);
  harness.stop();
  assert.equal(harness.requests[1].signal.aborted, true);
  pending.resolve(status("complete"));
  await flush();
  assert.deepEqual(harness.statuses, ["running"]);
  assert.equal(harness.documents, 0);
});

test("a replacement generation cannot be overwritten by an old request", async () => {
  const pending = deferred();
  const shared = {};
  const old = pollingHarness({ responses: [status("running"), () => pending.promise], shared });
  await flush();
  await flush();
  old.stop();
  const next = pollingHarness({ responses: [status("complete")], shared });
  await flush();
  pending.resolve(status("running"));
  await flush();
  assert.deepEqual(shared.statuses, ["running", "complete"]);
  assert.equal(next.documents, 1);
});

test("each live generation has one Organization request in flight", async () => {
  const pending = deferred();
  const harness = pollingHarness({ responses: [status("running"), () => pending.promise] });
  await flush();
  await flush();
  assert.equal(harness.inFlight, 1);
  assert.equal(harness.maxInFlight, 1);
  harness.stop();
});

test("complete and empty stop and refresh documents/workflow once", async () => {
  for (const terminal of ["complete", "empty"]) {
    const harness = pollingHarness({ responses: [status(terminal)] });
    await flush();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.documents, 1);
    assert.equal(harness.workflowCalls, 2);
  }
});

test("unconfirmed workflow ownership starts no Organization work", async () => {
  const harness = pollingHarness({ workflow: null });
  await flush();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.errors.length, 1);
});
