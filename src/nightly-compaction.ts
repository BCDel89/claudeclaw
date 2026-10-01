import { closeSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getClaudeProjectDir, findSessionJsonlPath } from "./sessionFiles";
import { listThreadSessions } from "./sessionManager";
import { compactCurrentThreadSession } from "./runner";

const TAIL_BYTES = 4 * 1024 * 1024;
// Compacting a very large session can take well over the normal per-turn timeout
// (~3.5 min observed for 120k tokens), and nobody is waiting on it at night.
const COMPACT_TIMEOUT_MS = 30 * 60_000;

/**
 * Current context size of a session, from its transcript: the token usage of the most recent
 * assistant turn (fresh input + cache read + cache write). Returns 0 when the transcript's last
 * event is a compaction boundary with no turn after it — the session was just compacted.
 * Returns null when no usage can be found.
 */
export function sessionContextTokens(jsonlPath: string): number | null {
  const size = statSync(jsonlPath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(jsonlPath, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  // The first line of a tail read is usually partial; JSON.parse failures are skipped anyway.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary") return 0;
    const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
    if (usage) {
      return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
  }
  return null;
}

export interface NightlyCompactionResult {
  compacted: { threadId: string; tokens: number }[];
  failed: { threadId: string; tokens: number; reason: string }[];
  skipped: { threadId: string; reason: string }[];
}

/**
 * Compacts every thread session whose context is at least `minTokens`, one at a time.
 * Each compaction goes through the thread's normal run queue, so it can't race a live turn.
 */
export async function runNightlyCompaction(minTokens: number): Promise<NightlyCompactionResult> {
  const result: NightlyCompactionResult = { compacted: [], failed: [], skipped: [] };
  const homeProjectDir = getClaudeProjectDir(process.cwd());

  for (const session of await listThreadSessions()) {
    const { threadId, sessionId } = session;
    const jsonl = findSessionJsonlPath(sessionId, process.cwd());
    if (!jsonl) {
      result.skipped.push({ threadId, reason: "transcript not found" });
      continue;
    }
    // Agent threads run from their own directory; resuming them from the daemon's cwd would
    // fail, so leave them for Claude Code's own auto-compact.
    if (dirname(jsonl) !== homeProjectDir) {
      result.skipped.push({ threadId, reason: "session runs from a different working directory" });
      continue;
    }
    let tokens: number | null;
    try {
      tokens = sessionContextTokens(jsonl);
    } catch (err) {
      result.skipped.push({ threadId, reason: `could not read transcript: ${err instanceof Error ? err.message : err}` });
      continue;
    }
    if (tokens === null || tokens < minTokens) continue;

    console.log(`[nightly-compaction] ${threadId}: ${Math.round(tokens / 1000)}k tokens, compacting`);
    const { success, message } = await compactCurrentThreadSession(threadId, undefined, COMPACT_TIMEOUT_MS);
    if (success) result.compacted.push({ threadId, tokens });
    else result.failed.push({ threadId, tokens, reason: message });
  }

  console.log(
    `[nightly-compaction] done: ${result.compacted.length} compacted, ${result.failed.length} failed, ${result.skipped.length} skipped`,
  );
  for (const s of result.skipped) console.log(`[nightly-compaction] skipped ${s.threadId}: ${s.reason}`);
  return result;
}
