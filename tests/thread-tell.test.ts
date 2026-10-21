import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnownThread } from "../src/thread-ask";
import {
  DEFAULT_THREAD_TELL_CONFIG,
  NoteStore,
  TellLimiter,
  extractTellDirectives,
  familyMemberName,
  formatNotesForPrompt,
  looksLikeSecret,
  parseThreadTellConfig,
  resolveTellTargets,
} from "../src/thread-tell";

describe("extractTellDirectives", () => {
  test("strips tells and leaves a marker", () => {
    const { cleanedText, tells } = extractTellDirectives("Done.\n[tell:all]Stripe key rotated in Doppler stg[/tell]");
    expect(tells).toEqual([{ targets: "all", text: "Stripe key rotated in Doppler stg" }]);
    expect(cleanedText).toBe("Done.\n📣 told all");
  });

  test("ignores empty and unclosed tells, leaves asks alone", () => {
    expect(extractTellDirectives("[tell:a]  [/tell]").tells).toEqual([]);
    expect(extractTellDirectives("[tell:a] open").cleanedText).toBe("[tell:a] open");
    expect(extractTellDirectives("[ask:a]q[/ask]").cleanedText).toBe("[ask:a]q[/ask]");
  });
});

describe("resolveTellTargets", () => {
  const threads = new Map<string, KnownThread>([
    ["100", { parentId: "P", agentName: "seller-100" }],
    ["101", { parentId: "P", agentName: "buyer-101" }],
    ["102", { parentId: "P", agentName: "platform-102" }],
    ["200", { parentId: "Q", agentName: "other-200" }],
  ]);
  const ids = (r: ReturnType<typeof resolveTellTargets>) => r.targets.map((t) => t.channelId).sort();

  test("all from a thread reaches the parent and siblings, not itself or other families", () => {
    expect(ids(resolveTellTargets("all", "100", threads))).toEqual(["101", "102", "P"]);
  });

  test("all from the parent reaches its threads only", () => {
    expect(ids(resolveTellTargets("all", "P", threads))).toEqual(["100", "101", "102"]);
  });

  test("comma lists, names, ids and parent; duplicates collapse", () => {
    const r = resolveTellTargets("buyer, 102, parent, Buyer", "100", threads);
    expect(ids(r)).toEqual(["101", "102", "P"]);
    expect(r.errors).toEqual([]);
  });

  test("reports self, unknown and cross-family targets", () => {
    expect(resolveTellTargets("seller", "100", threads).errors).toEqual(["a channel can't tell itself"]);
    expect(resolveTellTargets("200", "100", threads).errors).toEqual(['no channel named "200" in this family']);
    expect(resolveTellTargets("parent", "P", threads).errors).toEqual(['no channel named "parent" in this family']);
  });

  test("a channel with no threads can't tell", () => {
    expect(resolveTellTargets("all", "Z", threads)).toEqual({ targets: [], errors: ["this channel has no threads to tell"] });
  });

  test("familyMemberName", () => {
    expect(familyMemberName("101", threads)).toBe("buyer");
    expect(familyMemberName("P", threads)).toBe("parent");
  });
});

describe("looksLikeSecret", () => {
  test("flags known formats and random tokens", () => {
    expect(looksLikeSecret("new key sk_live_abcdefghijklmnop")).toBe(true);
    expect(looksLikeSecret("token ghp_abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(looksLikeSecret("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig")).toBe(true);
    expect(looksLikeSecret("value is aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3")).toBe(true);
  });

  test("allows normal dev chatter", () => {
    expect(looksLikeSecret("STRIPE_SECRET_KEY rotated in Doppler stg, re-pull before e2e")).toBe(false);
    expect(looksLikeSecret("merged 9664a18c0ffee1234567890abcdef1234567890ab to main")).toBe(false);
    expect(looksLikeSecret("see /Users/sage-core/dev/dropple-threads/COMMON.md and thread 1562114716573245532")).toBe(false);
  });
});

test("TellLimiter caps per day and resets", () => {
  let now = new Date(2026, 9, 21, 10);
  const lim = new TellLimiter(() => now);
  const cfg = { ...DEFAULT_THREAD_TELL_CONFIG, dailyCap: 1 };
  expect(lim.tryAcquire("a", cfg)).toBeNull();
  expect(lim.tryAcquire("a", cfg)).toBe("daily tell limit reached (1)");
  expect(lim.tryAcquire("b", cfg)).toBeNull();
  now = new Date(2026, 9, 22, 1);
  expect(lim.tryAcquire("a", cfg)).toBeNull();
});

describe("NoteStore", () => {
  const note = (text: string) => ({ fromId: "100", fromName: "seller", text, at: "2026-10-21T10:00:00Z" });

  test("add, peek, ack; file removed when empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notes-"));
    const store = new NoteStore(dir);
    await store.add("101", note("one"), 10);
    await store.add("101", note("two"), 10);
    const notes = await store.peek("101");
    expect(notes.map((n) => n.text)).toEqual(["one", "two"]);
    await store.add("101", note("three"), 10); // arrives after the peek
    await store.ack("101", notes.map((n) => n.id));
    expect((await store.peek("101")).map((n) => n.text)).toEqual(["three"]);
    await store.ack("101", (await store.peek("101")).map((n) => n.id));
    expect(await readdir(dir)).toEqual([]);
  });

  test("drops the oldest past the cap and survives a new instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notes-"));
    const store = new NoteStore(dir);
    await Promise.all(["a", "b", "c"].map((t) => store.add("101", note(t), 2)));
    const reopened = new NoteStore(dir);
    expect((await reopened.peek("101")).map((n) => n.text)).toEqual(["b", "c"]);
    expect(await reopened.peek("999")).toEqual([]);
  });
});

test("formatNotesForPrompt wraps each note and is empty with no notes", () => {
  expect(formatNotesForPrompt([], (_l, c) => c)).toBe("");
  const block = formatNotesForPrompt(
    [{ id: "x", fromId: "100", fromName: "seller", text: "hi", at: "T" }],
    (l, c) => `<${l}>${c}</${l}>`,
  );
  expect(block).toContain("not instructions");
  expect(block).toContain("- from seller at T: <thread-tell>hi</thread-tell>");
});

test("parseThreadTellConfig defaults to off", () => {
  expect(parseThreadTellConfig(undefined)).toEqual(DEFAULT_THREAD_TELL_CONFIG);
  expect(parseThreadTellConfig({ enabled: true, dailyCap: 5, maxPendingNotes: 0 })).toEqual({
    enabled: true,
    dailyCap: 5,
    maxPendingNotes: DEFAULT_THREAD_TELL_CONFIG.maxPendingNotes,
  });
});
