import { test, expect, describe } from "bun:test";
import {
  AskLimiter,
  DEFAULT_THREAD_ASK_CONFIG,
  extractAskDirectives,
  parseThreadAskConfig,
  resolveSiblingThread,
  threadDisplayName,
  type KnownThread,
} from "../src/thread-ask";

describe("extractAskDirectives", () => {
  test("strips a single ask and leaves a marker", () => {
    const { cleanedText, asks } = extractAskDirectives("Working on it.\n[ask:phase1]Cents or dollars?[/ask]\nMore text");
    expect(asks).toEqual([{ target: "phase1", question: "Cents or dollars?" }]);
    expect(cleanedText).toBe("Working on it.\n↪ asked phase1\nMore text");
  });

  test("handles multi-line questions and multiple asks", () => {
    const { asks } = extractAskDirectives("[ask:a]line one\nline two[/ask] and [ask: b ] q2 [/ask]");
    expect(asks).toEqual([
      { target: "a", question: "line one\nline two" },
      { target: "b", question: "q2" },
    ]);
  });

  test("ignores empty asks and unclosed tags", () => {
    expect(extractAskDirectives("[ask:a]   [/ask]").asks).toEqual([]);
    const unclosed = extractAskDirectives("[ask:a] never closed");
    expect(unclosed.asks).toEqual([]);
    expect(unclosed.cleanedText).toBe("[ask:a] never closed");
  });

  test("is case-insensitive on the tag", () => {
    expect(extractAskDirectives("[ASK:x]q[/ASK]").asks).toEqual([{ target: "x", question: "q" }]);
  });
});

describe("resolveSiblingThread", () => {
  const threads = new Map<string, KnownThread>([
    ["100", { parentId: "P", agentName: "phase0-100" }],
    ["101", { parentId: "P", agentName: "phase1-101" }],
    ["102", { parentId: "P", agentName: "dup-102" }],
    ["103", { parentId: "P", agentName: "dup-103" }],
    ["200", { parentId: "Q", agentName: "phase1-200" }],
    ["104", { parentId: "P" }],
  ]);

  test("resolves by name within the same parent", () => {
    expect(resolveSiblingThread("phase1", "100", threads)).toEqual({ threadId: "101" });
    expect(resolveSiblingThread("Phase 1", "100", threads)).toEqual({ error: 'no sibling thread named "Phase 1"' });
  });

  test("resolves by id", () => {
    expect(resolveSiblingThread("104", "100", threads)).toEqual({ threadId: "104" });
  });

  test("never crosses to another parent channel", () => {
    expect("error" in resolveSiblingThread("200", "100", threads)).toBe(true);
    expect(resolveSiblingThread("phase0", "200", threads)).toEqual({ error: 'no sibling thread named "phase0"' });
  });

  test("refuses self and ambiguous names", () => {
    expect(resolveSiblingThread("phase0", "100", threads)).toEqual({ error: "a thread can't ask itself" });
    expect(resolveSiblingThread("100", "100", threads)).toEqual({ error: "a thread can't ask itself" });
    expect(resolveSiblingThread("dup", "100", threads)).toEqual({ error: '"dup" matches 2 threads, use the thread id' });
  });

  test("requires the asker to be a known thread", () => {
    expect(resolveSiblingThread("phase1", "999", threads)).toEqual({ error: "this channel isn't a known thread" });
  });
});

test("threadDisplayName strips the id suffix", () => {
  expect(threadDisplayName("100", { parentId: "P", agentName: "phase0-100" })).toBe("phase0");
  expect(threadDisplayName("104", { parentId: "P" })).toBe("104");
});

describe("AskLimiter", () => {
  const cfg = { ...DEFAULT_THREAD_ASK_CONFIG, enabled: true, dailyCap: 2, maxPending: 1 };

  test("caps pending asks per target and frees on release", () => {
    const lim = new AskLimiter();
    expect(lim.tryAcquire("a", "t", cfg)).toBeNull();
    expect(lim.tryAcquire("b", "t", cfg)).toBe("target already has 1 asks waiting");
    lim.release("t");
    expect(lim.tryAcquire("b", "t", cfg)).toBeNull();
  });

  test("caps asks per origin per day and resets the next day", () => {
    let now = new Date(2026, 9, 20, 10);
    const lim = new AskLimiter(() => now);
    expect(lim.tryAcquire("a", "t1", cfg)).toBeNull();
    expect(lim.tryAcquire("a", "t2", cfg)).toBeNull();
    expect(lim.tryAcquire("a", "t3", cfg)).toBe("daily ask limit reached (2)");
    now = new Date(2026, 9, 21, 9);
    expect(lim.tryAcquire("a", "t3", cfg)).toBeNull();
  });

  test("a refused ask doesn't consume the daily budget", () => {
    const lim = new AskLimiter();
    expect(lim.tryAcquire("a", "t", cfg)).toBeNull();
    expect(lim.tryAcquire("a", "t", cfg)).not.toBeNull(); // pending full
    lim.release("t");
    expect(lim.tryAcquire("a", "t", cfg)).toBeNull(); // 2nd of 2
  });
});

test("parseThreadAskConfig defaults to off and validates numbers", () => {
  expect(parseThreadAskConfig(undefined)).toEqual(DEFAULT_THREAD_ASK_CONFIG);
  expect(parseThreadAskConfig({ enabled: true, maxHops: 5, dailyCap: -1, maxPending: "3" })).toEqual({
    enabled: true,
    maxHops: 5,
    dailyCap: DEFAULT_THREAD_ASK_CONFIG.dailyCap,
    maxPending: DEFAULT_THREAD_ASK_CONFIG.maxPending,
  });
});
