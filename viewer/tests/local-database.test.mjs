import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("local SQLite preserves the viewer database contract", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-local-sqlite-"));
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    assert.equal(await getLocalDatabase(), db);
    assert.equal(existsSync(join(stateDir, "oxygen.sqlite")), true);

    const schema = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents', 'workflow_runs') ORDER BY name",
    ).all();
    assert.deepEqual(schema.results.map((row) => row.name), ["documents", "workflow_runs"]);

    const inserted = await db.prepare(`INSERT INTO documents
      (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
      .bind("first", "synthetic", "First", "2036-01-01", "2036-01-01").run();
    assert.deepEqual(inserted, { success: true, meta: { changes: 1 } });

    const first = await db.prepare("SELECT id,title FROM documents WHERE id=?").bind("first").first();
    assert.deepEqual(first, { id: "first", title: "First" });
    assert.equal(Object.getPrototypeOf(first), Object.prototype);

    const all = await db.prepare("SELECT id,title FROM documents ORDER BY id").all();
    assert.deepEqual(all, { results: [{ id: "first", title: "First" }] });
    assert.equal(Object.getPrototypeOf(all.results[0]), Object.prototype);

    const mixed = await db.batch([
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("second", "synthetic", "Second", "2036-01-01", "2036-01-01"),
      db.prepare("SELECT id FROM documents ORDER BY id"),
    ]);
    assert.deepEqual(mixed, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 }, results: [{ id: "first" }, { id: "second" }] },
    ]);

    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("rolled-back", "synthetic", "Rolled back", "2036-01-01", "2036-01-01"),
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("first", "synthetic", "Duplicate", "2036-01-01", "2036-01-01"),
    ]));
    assert.equal(await db.prepare("SELECT id FROM documents WHERE id=?").bind("rolled-back").first(), null);

    const [casZero, casOne] = await db.batch([
      db.prepare("UPDATE documents SET title=? WHERE id=? AND title=?").bind("Changed", "first", "stale"),
      db.prepare("UPDATE documents SET title=? WHERE id=? AND title=?").bind("Changed", "first", "First"),
    ]);
    assert.equal(casZero.meta.changes, 0);
    assert.equal(casOne.meta.changes, 1);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    await rm(stateDir, { recursive: true, force: true });
  }
});
