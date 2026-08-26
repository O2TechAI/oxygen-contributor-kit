import test from "node:test";
import assert from "node:assert/strict";

const lifecycleModule = await import("../lib/organization-polling-lifecycle.ts")
  .catch((importError) => ({ importError }));

function lifecycleContract() {
  assert.equal(
    lifecycleModule.importError,
    undefined,
    "Organization polling lifecycle helper must exist",
  );
  return lifecycleModule;
}

class ManualScheduler {
  nextId = 1;
  tasks = new Map();
  delays = [];

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    this.delays.push(delay);
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  runNext() {
    const next = this.tasks.entries().next().value;
    if (!next) return null;
    const [id, task] = next;
    this.tasks.delete(id);
    task.callback();
    return task.delay;
  }

  runAll(limit = 100) {
    let ran = 0;
    while (this.tasks.size) {
      if (ran >= limit) throw new Error("scheduler did not quiesce");
      this.runNext();
      ran += 1;
    }
    return ran;
  }
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const flush = async (turns = 8) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const organizationStatus = (status) => ({
  status,
  stage: "classify",
  completed: status === "complete" ? 1 : 0,
  total: 1,
  percent: status === "complete" ? 100 : 0,
  documentCount: 1,
  warnings: [],
});

const requestError = (message, { status, retryable } = {}) => Object.assign(
  new Error(message),
  ...(status === undefined ? [] : [{ status }]),
  ...(retryable === undefined ? [] : [{ retryable }]),
);

function createHarness({
  workflow = { currentStageId: "organize" },
  organization = [organizationStatus("running")],
  loadWorkflow: loadWorkflowOverride,
  loadDocuments: loadDocumentsOverride,
} = {}) {
  const scheduler = new ManualScheduler();
  const requests = [];
  const statuses = [];
  const errors = [];
  const recoveries = [];
  const workflowSignals = [];
  const documentSignals = [];
  let workflowCalls = 0;
  let documentCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const loadWorkflow = loadWorkflowOverride || (async (signal) => {
    workflowCalls += 1;
    workflowSignals.push(signal);
    return workflow;
  });
  const loadDocuments = loadDocumentsOverride || (async (signal) => {
    documentCalls += 1;
    documentSignals.push(signal);
  });
  const requestOrganization = (request) => {
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const next = organization.shift();
    const result = typeof next === "function" ? next(request) : next;
    return (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
      .finally(() => { inFlight -= 1; });
  };

  const { OrganizationPollingLifecycle } = lifecycleContract();
  const lifecycle = new OrganizationPollingLifecycle({
    loadWorkflow,
    requestOrganization,
    loadDocuments,
    onStatus: (value) => statuses.push(value.status),
    onError: (message) => errors.push(message),
    onRecovered: () => recoveries.push("cleared"),
    scheduler,
  });

  return {
    lifecycle,
    scheduler,
    requests,
    statuses,
    errors,
    recoveries,
    workflowSignals,
    documentSignals,
    get workflowCalls() { return workflowCalls; },
    get documentCalls() { return documentCalls; },
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
  };
}

test("transient Organization failure retries and then recovers in the same generation", async () => {
  const harness = createHarness({
    organization: [
      requestError("offline"),
      organizationStatus("running"),
    ],
  });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.scheduler.runNext(), 500);
  await flush();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.ok(harness.errors.length >= 1);
  assert.deepEqual(harness.recoveries, ["cleared"]);
});

test("cleanup during an in-flight Organization POST aborts and suppresses later activity", async () => {
  const post = deferred();
  const harness = createHarness({
    organization: [organizationStatus("running"), () => post.promise],
  });
  harness.lifecycle.start();
  await flush();
  harness.scheduler.runNext();
  await flush();
  assert.equal(harness.requests.length, 2);
  const statusCount = harness.statuses.length;
  const workflowCalls = harness.workflowCalls;
  harness.lifecycle.stop();
  assert.equal(harness.requests[1].signal.aborted, true);
  post.resolve(organizationStatus("complete"));
  await flush();
  assert.equal(harness.statuses.length, statusCount);
  assert.equal(harness.workflowCalls, workflowCalls);
  assert.equal(harness.documentCalls, 0);
  assert.equal(harness.scheduler.tasks.size, 0);
});

test("a stale old-generation POST result cannot apply after replacement", async () => {
  const oldPost = deferred();
  const harness = createHarness({
    organization: [
      organizationStatus("running"),
      () => oldPost.promise,
      organizationStatus("complete"),
    ],
  });
  harness.lifecycle.start();
  await flush();
  harness.scheduler.runNext();
  await flush();
  harness.lifecycle.start();
  await flush();
  oldPost.resolve(organizationStatus("running"));
  await flush();
  assert.deepEqual(harness.statuses, ["running", "complete"]);
  assert.equal(harness.documentCalls, 1);
});

test("one live generation has at most one physical Organization request in flight", async () => {
  const post = deferred();
  const harness = createHarness({
    organization: [organizationStatus("running"), () => post.promise],
  });
  harness.lifecycle.start();
  await flush();
  harness.scheduler.runNext();
  await flush();
  assert.equal(harness.inFlight, 1);
  assert.equal(harness.maxInFlight, 1);
  assert.equal(harness.scheduler.tasks.size, 0);
  post.resolve(organizationStatus("running"));
  await flush();
  assert.equal(harness.maxInFlight, 1);
});

test("retry exhaustion surfaces a stable error and stops safely", async () => {
  const harness = createHarness({
    organization: [
      requestError("offline-1"),
      requestError("offline-2"),
      requestError("offline-3"),
      requestError("offline-4"),
    ],
  });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.scheduler.runNext(), 500);
  await flush();
  assert.equal(harness.scheduler.runNext(), 1000);
  await flush();
  assert.equal(harness.scheduler.runNext(), 2000);
  await flush();
  assert.equal(harness.requests.length, 4);
  assert.equal(harness.scheduler.tasks.size, 0);
  assert.ok(harness.errors.at(-1));
});

test("transient failure classification covers network, 408, 425, 429, and 5xx only", () => {
  const { isTransientOrganizationPollingFailure } = lifecycleContract();
  assert.equal(isTransientOrganizationPollingFailure(requestError("network")), true);
  for (const status of [408, 425, 429, 500, 503]) {
    assert.equal(isTransientOrganizationPollingFailure(requestError(`HTTP ${status}`, { status })), true);
  }
  assert.equal(isTransientOrganizationPollingFailure(requestError("bad request", { status: 400 })), false);
  assert.equal(isTransientOrganizationPollingFailure(requestError("invalid payload", { retryable: false })), false);
});

test("ordinary non-transient 4xx failures do not retry", async () => {
  const harness = createHarness({ organization: [requestError("bad request", { status: 400 })] });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.scheduler.tasks.size, 0);
  assert.equal(harness.errors.length, 1);
});

test("successful nonterminal batches use a bounded non-zero helper cadence", async () => {
  const { ORGANIZATION_BATCH_DELAY_MS } = lifecycleContract();
  assert.ok(ORGANIZATION_BATCH_DELAY_MS > 0);
  const harness = createHarness({
    organization: [organizationStatus("running"), organizationStatus("running")],
  });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.scheduler.runNext(), ORGANIZATION_BATCH_DELAY_MS);
  await flush();
  assert.equal(harness.scheduler.delays.at(-1), ORGANIZATION_BATCH_DELAY_MS);
  assert.ok(harness.requests.every((request) => request.signal instanceof AbortSignal));
});

test("complete stops further Organization requests", async () => {
  const harness = createHarness({
    organization: [organizationStatus("running"), organizationStatus("complete")],
  });
  harness.lifecycle.start();
  await flush();
  harness.scheduler.runNext();
  await flush();
  assert.deepEqual(harness.statuses, ["running", "complete"]);
  assert.equal(harness.scheduler.tasks.size, 0);
  assert.equal(harness.requests.length, 2);
});

test("empty stops further Organization requests", async () => {
  const harness = createHarness({ organization: [organizationStatus("empty")] });
  harness.lifecycle.start();
  await flush();
  assert.deepEqual(harness.statuses, ["empty"]);
  assert.equal(harness.scheduler.tasks.size, 0);
  assert.equal(harness.requests.length, 1);
});

test("a live terminal generation refreshes documents and workflow at most once", async () => {
  const harness = createHarness({ organization: [organizationStatus("complete")] });
  harness.lifecycle.start();
  await flush();
  await flush();
  assert.equal(harness.documentCalls, 1);
  assert.equal(harness.workflowCalls, 2);
  await flush();
  assert.equal(harness.documentCalls, 1);
  assert.equal(harness.workflowCalls, 2);
});

test("unconfirmed initial workflow ownership does not start Organization POST work", async () => {
  const harness = createHarness({ workflow: null });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.scheduler.tasks.size, 0);
  assert.equal(harness.errors.length, 1);
});

test("a recovered current generation clears only its transient polling error", async () => {
  const harness = createHarness({
    organization: [requestError("network"), organizationStatus("complete")],
  });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.errors.length, 1);
  harness.scheduler.runNext();
  await flush();
  assert.deepEqual(harness.recoveries, ["cleared"]);
  assert.equal(harness.documentCalls, 1);
});

test("cleanup before an initial Organization response prevents all later state and refresh activity", async () => {
  const initial = deferred();
  const harness = createHarness({ organization: [() => initial.promise] });
  harness.lifecycle.start();
  await flush();
  assert.equal(harness.requests.length, 1);
  harness.lifecycle.stop();
  assert.equal(harness.requests[0].signal.aborted, true);
  initial.resolve(organizationStatus("complete"));
  await flush();
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.recoveries, []);
  assert.equal(harness.documentCalls, 0);
  assert.equal(harness.workflowCalls, 1);
});
