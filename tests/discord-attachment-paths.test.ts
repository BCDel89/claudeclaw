import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAttachmentPaths } from "../src/commands/discord";

let root: string;
let outside: string;
let fresh: string;
let stale: string;
let elsewhere: string;
const startedAt = Date.now();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cc-outbox-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "cc-outside-")));
  fresh = join(root, "fresh.png");
  stale = join(root, "stale.png");
  elsewhere = join(outside, "elsewhere.png");
  for (const f of [fresh, stale, elsewhere]) writeFileSync(f, "x");
  const old = (startedAt - 10 * 60_000) / 1000;
  utimesSync(stale, old, old);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("attaches a bare path and removes it from the text", () => {
  const { paths, cleanedText } = extractAttachmentPaths(`Here it is: ${fresh}`, [root], startedAt);
  expect(paths).toEqual([fresh]);
  expect(cleanedText).toBe("Here it is:");
});

test("backtick-wrapped path is removed together with its backticks", () => {
  const { paths, cleanedText } = extractAttachmentPaths(`Side by side:\n\n\`${fresh}\`\n\nMy take: ok`, [root], startedAt);
  expect(paths).toEqual([fresh]);
  expect(cleanedText).not.toContain("``");
  expect(cleanedText).toBe("Side by side:\n\nMy take: ok");
});

test("stale file is left as text, not attached", () => {
  const text = `Old: \`${stale}\``;
  const { paths, cleanedText } = extractAttachmentPaths(text, [root], startedAt);
  expect(paths).toEqual([]);
  expect(cleanedText).toBe(text);
});

test("file outside the outbox roots is never attached", () => {
  const text = `See ${elsewhere}`;
  const { paths, cleanedText } = extractAttachmentPaths(text, [root], startedAt);
  expect(paths).toEqual([]);
  expect(cleanedText).toBe(text);
});

test("freshness is measured from the given start time, e.g. a job's start", () => {
  // Same stale file passes when the producing work started before it was written.
  const { paths } = extractAttachmentPaths(stale, [root], startedAt - 20 * 60_000);
  expect(paths).toEqual([stale]);
});

test("multiple paths keep their order", () => {
  const second = join(root, "second.md");
  writeFileSync(second, "y");
  const { paths } = extractAttachmentPaths(`\`${fresh}\` and ${second}`, [root], startedAt);
  expect(paths).toEqual([fresh, second]);
});
