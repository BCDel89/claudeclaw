import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionContextTokens } from "../src/nightly-compaction";

const dir = mkdtempSync(join(tmpdir(), "cc-compact-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function transcript(name: string, entries: object[]): string {
  const p = join(dir, name);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

const turn = (input: number, read: number, write: number) => ({
  type: "assistant",
  message: { role: "assistant", usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
});

test("uses the most recent assistant turn's full context size", () => {
  const p = transcript("a.jsonl", [turn(10, 100_000, 5), { type: "user", message: { role: "user" } }, turn(20, 300_000, 1_000)]);
  expect(sessionContextTokens(p)).toBe(301_020);
});

test("a compaction boundary after the last turn means the session was just compacted", () => {
  const p = transcript("b.jsonl", [turn(10, 650_000, 0), { type: "system", subtype: "compact_boundary" }, { type: "user", message: { role: "user" } }]);
  expect(sessionContextTokens(p)).toBe(0);
});

test("a turn after a compaction boundary is measured normally", () => {
  const p = transcript("c.jsonl", [turn(1, 650_000, 0), { type: "system", subtype: "compact_boundary" }, turn(5, 40_000, 2_000)]);
  expect(sessionContextTokens(p)).toBe(42_005);
});

test("no usage at all returns null; malformed lines are ignored", () => {
  const p = join(dir, "d.jsonl");
  writeFileSync(p, '{"type":"user"}\nnot json\n');
  expect(sessionContextTokens(p)).toBeNull();
});

import { nightlyCompactionDue } from "../src/nightly-compaction";

const CDT = -300;
const at = (iso: string) => new Date(iso);

test("not due before the configured hour", () => {
  // 02:59 local
  expect(nightlyCompactionDue(at("2026-10-02T07:59:00Z"), CDT, 3, "2026-10-01").due).toBe(false);
});

test("due at the configured hour when it hasn't run today", () => {
  const r = nightlyCompactionDue(at("2026-10-02T08:00:00Z"), CDT, 3, "2026-10-01");
  expect(r).toEqual({ due: true, today: "2026-10-02" });
});

test("catches up later the same day after a missed run (e.g. reboot at 3am)", () => {
  // 08:36 local, last run was yesterday
  expect(nightlyCompactionDue(at("2026-10-02T13:36:00Z"), CDT, 3, "2026-10-01").due).toBe(true);
  expect(nightlyCompactionDue(at("2026-10-02T13:36:00Z"), CDT, 3, null).due).toBe(true);
});

test("does not run twice in the same local day", () => {
  expect(nightlyCompactionDue(at("2026-10-02T20:00:00Z"), CDT, 3, "2026-10-02").due).toBe(false);
});

test("uses the local date, not UTC", () => {
  // 23:30 local on Oct 1 is already Oct 2 in UTC; last run Oct 1 local → not due
  expect(nightlyCompactionDue(at("2026-10-02T04:30:00Z"), CDT, 3, "2026-10-01").due).toBe(false);
});
