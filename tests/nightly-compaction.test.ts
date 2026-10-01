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
