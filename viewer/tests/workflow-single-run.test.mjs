import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveWorkflowProgress } from "../lib/workflow-progress.ts";
import {
  WORKFLOW_RUN_AUTHORITY,
  establishWorkflowRun,
  inspectEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../lib/workflow-run-server.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

class FakeWorkflowDb {
  runs = new Map();
  writeQueue = Promise.resolve();

  prepare(sql) {
    let values = [];
    return {
      bind(...next) {
        values = next;
        return this;
      },
      all: async () => {
        assert.match(sql, /SELECT id FROM workflow_runs ORDER BY id LIMIT 2/);
        return { results: [...this.runs.keys()].sort().slice(0, 2).map((id) => ({ id })) };
      },
      run: async () => {
        assert.match(sql, /INSERT INTO workflow_runs/);
        const previous = this.writeQueue;
        let release;
        this.writeQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
          if (this.runs.size > 0) return { meta: { changes: 0 } };
          const [id, createdAt, updatedAt] = values;
          this.runs.set(id, { id, createdAt, updatedAt, targetConfirmed: 1 });
          return { meta: { changes: 1 } };
        } finally {
          release();
        }
      },
    };
  }
}

test("single-run authority distinguishes no, exact, foreign, and unsupported multiple rows", async () => {
  const db = new FakeWorkflowDb();
  assert.deepEqual(await inspectEstablishedWorkflowRun(db), {
    state: WORKFLOW_RUN_AUTHORITY.noRun,
  });
  db.runs.set("run-a", { id: "run-a" });
  assert.deepEqual(await inspectEstablishedWorkflowRun(db), {
    state: WORKFLOW_RUN_AUTHORITY.exactRun,
    workflowRunId: "run-a",
  });
  assert.deepEqual(await inspectEstablishedWorkflowRun(db, "run-b"), {
    state: WORKFLOW_RUN_AUTHORITY.foreignRun,
  });
  db.runs.set("run-b", { id: "run-b" });
  assert.deepEqual(await inspectEstablishedWorkflowRun(db, "run-a"), {
    state: WORKFLOW_RUN_AUTHORITY.multipleRuns,
  });
  assert.deepEqual([...db.runs.keys()].sort(), ["run-a", "run-b"]);
});

test("concurrent first A/B establishment leaves one exact winner and one bounded conflict", async () => {
  const db = new FakeWorkflowDb();
  const now = "2033-01-02T03:04:05.000Z";
  const results = await Promise.all([
    establishWorkflowRun(db, "run-a", now),
    establishWorkflowRun(db, "run-b", now),
  ]);
  assert.equal(db.runs.size, 1);
  assert.deepEqual(results.map((result) => result.state).sort(), [
    WORKFLOW_RUN_AUTHORITY.exactRun,
    WORKFLOW_RUN_AUTHORITY.foreignRun,
  ].sort());
  const winner = results.find((result) => result.state === WORKFLOW_RUN_AUTHORITY.exactRun);
  assert.equal(winner.workflowRunId, [...db.runs.keys()][0]);
});

test("matching target confirmation is idempotent and never creates a second row", async () => {
  const db = new FakeWorkflowDb();
  const first = await establishWorkflowRun(db, "run-a", "2033-01-02T03:04:05.000Z");
  const second = await establishWorkflowRun(db, "run-a", "2033-01-02T03:04:06.000Z");
  assert.equal(first.state, WORKFLOW_RUN_AUTHORITY.exactRun);
  assert.equal(second.state, WORKFLOW_RUN_AUTHORITY.exactRun);
  assert.equal(db.runs.size, 1);
});

test("authority failures expose only fixed sanitized categories", async () => {
  for (const state of [
    WORKFLOW_RUN_AUTHORITY.noRun,
    WORKFLOW_RUN_AUTHORITY.foreignRun,
    WORKFLOW_RUN_AUTHORITY.multipleRuns,
  ]) {
    const response = workflowRunErrorResponse({ state });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: state === WORKFLOW_RUN_AUTHORITY.noRun
        ? "Workflow run is not established"
        : state === WORKFLOW_RUN_AUTHORITY.foreignRun
          ? "Requested workflow run is not established"
          : "Viewer workflow state is invalid",
      code: state,
    });
  }
});

test("neutral Progress bootstrap has no established or job-derived workflow identity", () => {
  const progress = deriveWorkflowProgress({
    workflowRunId: "",
    documentCount: 0,
    itemCount: 0,
    organizedItemCount: 0,
  });
  assert.equal(progress.workflowRunId, "");
  assert.equal(progress.safeStatusCode, "target_working_folder_required");
});

test("every Viewer-global route uses the canonical sole-run guard", async () => {
  const expectedCalls = new Map([
    ["../app/api/documents/route.ts", 2],
    ["../app/api/documents/[id]/route.ts", 1],
    ["../app/api/evidence/route.ts", 1],
    ["../app/api/organization/route.ts", 2],
    ["../app/api/redactions/route.ts", 2],
    ["../app/api/redactions/[id]/route.ts", 2],
    ["../app/api/probes/route.ts", 2],
    ["../app/api/probes/[id]/route.ts", 1],
  ]);
  for (const [path, expected] of expectedCalls) {
    const source = await read(path);
    assert.equal(
      source.match(/await requireEstablishedWorkflowRun\(db\)/g)?.length,
      expected,
      `${path} must guard every public handler`,
    );
    assert.match(source, /workflowRunErrorResponse/);
  }
});

test("workflow, Story session, source invalidation, and POST handoff are exact-run bounded", async () => {
  const [workflow, loader, documents, organization, session, releaseServer, html, packageRoute] = await Promise.all([
    read("../app/api/workflow/route.ts"),
    read("../lib/workflow-progress-server.ts"),
    read("../app/api/documents/route.ts"),
    read("../app/api/organization/route.ts"),
    read("../app/api/story-review-session/route.ts"),
    read("../lib/story-release-server.ts"),
    read("../app/api/organization/export/route.ts"),
    read("../app/api/package/route.ts"),
  ]);
  assert.match(workflow, /await establishWorkflowRun\(db, workflowRunId, now\)/);
  assert.match(workflow, /await requireExactWorkflowRun\(db, workflowRunId\)/);
  assert.doesNotMatch(workflow, /INSERT INTO workflow_runs[\s\S]+ON CONFLICT/);
  assert.doesNotMatch(loader, /FROM workflow_runs ORDER BY updated_at|JSON\.stringify\(\[organization/);
  assert.match(loader, /if \(authority\.state === WORKFLOW_RUN_AUTHORITY\.noRun[\s\S]+return deriveWorkflowProgress/);
  assert.match(documents, /WHERE id=\?`\)\.bind\(now, authority\.workflowRunId\)/);
  assert.match(organization, /WHERE id=\?`\)\.bind\(now, authority\.workflowRunId\)/);
  assert.equal(session.match(/await requireExactWorkflowRun\(db, /g)?.length, 2);
  assert.match(releaseServer, /await requireExactWorkflowRun\(db, request\.workflowRunId\)/);
  for (const [name, source] of [["HTML", html], ["ZIP", packageRoute]]) {
    const post = source.slice(source.indexOf("export async function POST"));
    assert.match(post, /await reconstructReviewedStoryRelease\(/, `${name} POST must use the exact-run release owner`);
    assert.doesNotMatch(post, /requireEstablishedWorkflowRun/, `${name} POST must not independently select a run`);
  }
});
