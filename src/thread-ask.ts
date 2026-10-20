// Thread-to-thread asks: a thread's reply can contain `[ask:<sibling>]question[/ask]`, and the
// Discord bridge delivers the question to a sibling thread (same parent channel) as a turn in
// that thread's session, then relays the answer back. Bot messages are ignored by the gateway,
// so this hand-off happens inside the bridge rather than by posting and waiting for a trigger.
// Pure logic lives here (parsing, sibling resolution, limits) so it can be tested in isolation.

export interface ThreadAskConfig {
  enabled: boolean;
  maxHops: number; // max asks in one chain (origin ask = hop 1)
  dailyCap: number; // max asks a single thread may start per local day
  maxPending: number; // max asks queued/in flight against one target thread
}

export const DEFAULT_THREAD_ASK_CONFIG: ThreadAskConfig = {
  enabled: false,
  maxHops: 3,
  dailyCap: 20,
  maxPending: 2,
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function parseThreadAskConfig(raw: unknown): ThreadAskConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_THREAD_ASK_CONFIG;
  return {
    enabled: r.enabled === true,
    maxHops: positiveInt(r.maxHops, d.maxHops),
    dailyCap: positiveInt(r.dailyCap, d.dailyCap),
    maxPending: positiveInt(r.maxPending, d.maxPending),
  };
}

export const MAX_ASKS_PER_REPLY = 3;

export interface AskDirective {
  target: string;
  question: string;
}

const ASK_RE = /\[ask:([^\]\r\n]+)\]([\s\S]*?)\[\/ask\]/gi;

/** Strip ask blocks from reply text, leaving a short visible marker in their place. */
export function extractAskDirectives(text: string): { cleanedText: string; asks: AskDirective[] } {
  const asks: AskDirective[] = [];
  const cleanedText = text
    .replace(ASK_RE, (_match, rawTarget, rawQuestion) => {
      const target = String(rawTarget).trim();
      const question = String(rawQuestion).trim();
      if (!target || !question) return "";
      asks.push({ target, question });
      return `↪ asked ${target}`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, asks };
}

export interface KnownThread {
  parentId: string;
  agentName?: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Display name for a thread: the slug part of its agentName ("phase0-1560…" -> "phase0"). */
export function threadDisplayName(threadId: string, info: KnownThread | undefined): string {
  const suffix = `-${threadId}`;
  if (info?.agentName?.endsWith(suffix)) return info.agentName.slice(0, -suffix.length);
  return threadId;
}

/**
 * Resolve an ask target (thread id or thread name) to a sibling thread of `fromThreadId`.
 * Only threads under the same parent channel are reachable.
 */
export function resolveSiblingThread(
  target: string,
  fromThreadId: string,
  threads: ReadonlyMap<string, KnownThread>,
): { threadId: string } | { error: string } {
  const from = threads.get(fromThreadId);
  if (!from) return { error: "this channel isn't a known thread" };
  const siblings = [...threads.entries()].filter(
    ([id, info]) => id !== fromThreadId && info.parentId === from.parentId,
  );
  const byId = siblings.find(([id]) => id === target);
  if (byId) return { threadId: byId[0] };
  if (target === fromThreadId) return { error: "a thread can't ask itself" };
  const slug = slugify(target);
  if (!slug) return { error: `"${target}" isn't a thread name` };
  const matches = siblings.filter(([id, info]) => threadDisplayName(id, info) === slug);
  if (matches.length === 1) return { threadId: matches[0][0] };
  if (matches.length > 1) return { error: `"${target}" matches ${matches.length} threads, use the thread id` };
  if (threadDisplayName(fromThreadId, from) === slug) return { error: "a thread can't ask itself" };
  return { error: `no sibling thread named "${target}"` };
}

/** Per-thread daily counts and per-target pending counts. In memory; resets on restart. */
export class AskLimiter {
  private daily = new Map<string, { day: string; count: number }>();
  private pending = new Map<string, number>();

  constructor(private now: () => Date = () => new Date()) {}

  private today(): string {
    const d = this.now();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /** Reserve a slot for an ask from `fromId` to `toId`, or return why it's refused. */
  tryAcquire(fromId: string, toId: string, cfg: ThreadAskConfig): string | null {
    const day = this.today();
    const entry = this.daily.get(fromId);
    const used = entry?.day === day ? entry.count : 0;
    if (used >= cfg.dailyCap) return `daily ask limit reached (${cfg.dailyCap})`;
    const queued = this.pending.get(toId) ?? 0;
    if (queued >= cfg.maxPending) return `target already has ${queued} asks waiting`;
    this.daily.set(fromId, { day, count: used + 1 });
    this.pending.set(toId, queued + 1);
    return null;
  }

  release(toId: string): void {
    const queued = this.pending.get(toId) ?? 0;
    if (queued <= 1) this.pending.delete(toId);
    else this.pending.set(toId, queued - 1);
  }
}
