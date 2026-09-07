import test from "node:test";
import assert from "node:assert/strict";
import { chapterSourceDateLabel } from "../lib/story-chapter-dates.ts";

const meeting = (date, clock = "19.36.00") => {
  const id = `meeting-example-transcript_${date}_${clock}-abc123`;
  return { id, title: id, kind: "meeting", source_system: "meeting-transcript", source_timestamp: null };
};
const source = (...ids) => ({ evidence: {
  primary: { documentId: ids[0], eventId: "anchor" },
  supporting: ids.slice(1).map((documentId, index) => ({ documentId, eventId: `support-${index}` })),
} });

test("Chapter dates cover all evidence documents at source calendar-day precision", () => {
  const july12 = meeting("2026-07-12");
  const july14 = meeting("2026-07-14", "19.35.16");
  const documents = [july14, july12];
  const chapter = { ...source(july14.id, july12.id, july12.id), timestamp: "19:03:39" };
  const before = JSON.stringify({ chapter, documents });
  assert.equal(chapterSourceDateLabel(chapter, documents), "Source dates · Jul 12, 2026 – Jul 14, 2026");
  assert.equal(chapterSourceDateLabel(source(july12.id, july14.id), documents), chapterSourceDateLabel(chapter, documents),
    "overlapping Chapters retain the same honest source-date range");
  assert.equal(chapterSourceDateLabel(source(july12.id, july12.id), documents), "Source dates · Jul 12, 2026");
  assert.equal(JSON.stringify({ chapter, documents }), before, "dates do not mutate source ownership or order");

  const offsetTimestamp = { ...july12, source_timestamp: "2026-07-11T23:30:00-08:00" };
  assert.equal(chapterSourceDateLabel(source(july12.id), [offsetTimestamp]), "Source dates · Jul 11, 2026",
    "valid source timestamps take priority and keep their original calendar date");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, source_timestamp: "19:03:39" }]), "Source dates · Jul 12, 2026");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, source_timestamp: "2026-07-11T24:00:00Z" }]), "Source dates · Jul 12, 2026",
    "a normalized invalid clock is not a source-date authority");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, source_timestamp: "2026-07-10" }]), "Source dates · Jul 10, 2026");

  const unknown = { id: "unrelated-2026-07-15", title: "Notes on 2026-07-15", kind: "chat" };
  assert.equal(chapterSourceDateLabel(source(unknown.id), [unknown]), "Source dates · Dates unavailable");
  assert.equal(chapterSourceDateLabel(source(july12.id, "missing"), documents), "Source dates · Jul 12, 2026 · Some dates unavailable");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, source_system: "other" }]), "Source dates · Dates unavailable");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, kind: "chat" }]), "Source dates · Dates unavailable");
  assert.equal(chapterSourceDateLabel(source(july12.id), [{ ...july12, title: july14.title }]), "Source dates · Dates unavailable",
    "conflicting source identifiers do not silently choose a date");
  const impossible = meeting("2026-02-30");
  assert.equal(chapterSourceDateLabel(source(impossible.id), [{ ...impossible, source_timestamp: "2026-02-30" }]), "Source dates · Dates unavailable");
  const leapDay = meeting("2024-02-29");
  assert.equal(chapterSourceDateLabel(source(leapDay.id), [leapDay]), "Source dates · Feb 29, 2024");
  assert.equal(chapterSourceDateLabel(source("missing"), [], "zh"), "相关记录日期 · 日期不可用");
});

test("an exact primary event preserves a reliable date only when every document date is unknown", () => {
  const document = { id: "trajectory", title: "Trajectory", kind: "trajectory" };
  const chapter = source(document.id);
  const anchor = { documentId: document.id, timestamp: "2026-07-11T23:30:00-08:00" };
  assert.equal(chapterSourceDateLabel(chapter, [document], "en", anchor), "Primary event date · Jul 11, 2026");
  assert.equal(chapterSourceDateLabel(chapter, [document], "zh", anchor), "主要证据事件日期 · 2026年7月11日");
  assert.equal(chapterSourceDateLabel(chapter, [document], "en", { ...anchor, timestamp: "2026-07-11" }), "Primary event date · Jul 11, 2026");
  assert.equal(chapterSourceDateLabel(chapter, [document], "en", { ...anchor, documentId: "foreign" }), "Source dates · Dates unavailable");
  for (const timestamp of ["19:03:39", "2026-02-30T01:00:00Z", "2026-07-11T24:00:00Z", "2026-07-11T23:30:00", "2026-07-11T23:30:00-00:00"]) {
    assert.equal(chapterSourceDateLabel(chapter, [document], "en", { ...anchor, timestamp }), "Source dates · Dates unavailable");
  }
  const knownDocument = { ...document, source_timestamp: "2026-07-12" };
  assert.equal(chapterSourceDateLabel(chapter, [knownDocument], "en", anchor), "Source dates · Jul 12, 2026");
  assert.equal(chapterSourceDateLabel(source(document.id, "missing"), [knownDocument], "en", anchor), "Source dates · Jul 12, 2026 · Some dates unavailable");
});
