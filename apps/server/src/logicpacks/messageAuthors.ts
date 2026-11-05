// @effect-diagnostics nodeBuiltinImport:off -- a tiny synchronous JSON file store.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PRESENCE_COLOR_COUNT } from "@logicpacks/contracts";

import { presenceColorIndex } from "./presence.ts";
import { memberSubject } from "./projectAccess.ts";

/** The host operator's stable id for colour hashing; matches presenceConnection's HOST_ACTOR_ID. */
const HOST_COLOR_KEY = "host";

interface StoreData {
  threads: Record<string, Record<string, string | null>>;
  colors: Record<string, number>;
}

export const MESSAGE_AUTHORS_FILE = "lp-message-authors.json";

/** The colour slot a person wears everywhere: the admin's pick, else the stable hash presence uses. */
export const defaultPersonColor = (userId: string | null): number =>
  presenceColorIndex(userId === null ? HOST_COLOR_KEY : memberSubject(userId));

const validColor = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < PRESENCE_COLOR_COUNT;

/**
 * Who sent each user message, and each person's admin-chosen colour. A small JSON file
 * with atomic writes; the server never stored message authors before this.
 */
export class MessageAuthorStore {
  private data: StoreData = { threads: {}, colors: {} };
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      if (NodeFS.existsSync(path)) {
        const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<StoreData>;
        this.data = {
          threads: typeof parsed.threads === "object" && parsed.threads !== null ? parsed.threads : {},
          colors: typeof parsed.colors === "object" && parsed.colors !== null ? parsed.colors : {},
        };
      }
    } catch {
      // A damaged file starts empty; authors only decorate messages.
    }
  }

  private persist(): void {
    try {
      NodeFS.mkdirSync(NodePath.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      NodeFS.writeFileSync(tmp, JSON.stringify(this.data));
      NodeFS.renameSync(tmp, this.path);
    } catch {
      // Best effort: the in-memory copy still serves this run.
    }
  }

  /** Records who sent a message (null = host owner). First write wins. */
  record(threadId: string, messageId: string, userId: string | null): void {
    const thread = (this.data.threads[threadId] ??= {});
    if (Object.hasOwn(thread, messageId)) return;
    thread[messageId] = userId;
    this.separateColor(userId);
    this.persist();
  }

  /**
   * Two people in one project must not share a colour just because their ids hash alike: the
   * first time someone is recorded, a taken default moves to the lowest colour nobody uses.
   */
  private separateColor(userId: string | null): void {
    const key = userId ?? HOST_COLOR_KEY;
    if (Object.hasOwn(this.data.colors, key)) return;
    const others = new Set<string>();
    for (const thread of Object.values(this.data.threads))
      for (const author of Object.values(thread)) others.add(author ?? HOST_COLOR_KEY);
    others.delete(key);
    const taken = new Set([...others].map((other) => this.colorOf(other === HOST_COLOR_KEY ? null : other)));
    const mine = this.colorOf(userId);
    if (!taken.has(mine)) return;
    for (let color = 0; color < 8; color += 1) {
      if (!taken.has(color)) {
        this.data.colors[key] = color;
        return;
      }
    }
  }

  /** messageId -> userId|null for the thread; absent ids are unknown. */
  authorsOf(threadId: string): Readonly<Record<string, string | null>> {
    return this.data.threads[threadId] ?? {};
  }

  colorOf(userId: string | null): number {
    const set = this.data.colors[userId ?? HOST_COLOR_KEY];
    return validColor(set) ? set : defaultPersonColor(userId);
  }

  setColor(userId: string | null, color: number): boolean {
    if (!validColor(color)) return false;
    this.data.colors[userId ?? HOST_COLOR_KEY] = color;
    this.persist();
    return true;
  }
}

const stores = new Map<string, MessageAuthorStore>();

/** One store per state dir, shared by the fence, the routes and presence. */
export const messageAuthorStore = (stateDir: string): MessageAuthorStore => {
  const path = NodePath.join(stateDir, MESSAGE_AUTHORS_FILE);
  let store = stores.get(path);
  if (store === undefined) {
    store = new MessageAuthorStore(path);
    stores.set(path, store);
  }
  return store;
};

/** The user message a command or launch sends: [threadId, messageId], or null. */
export const dispatchedMessage = (
  method: string,
  payload: unknown,
  result: unknown,
): { readonly threadId: string; readonly messageId: string } | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (method === "orchestration.dispatchCommand" && record["type"] === "message.dispatch") {
    const { threadId, messageId } = record;
    return typeof threadId === "string" && typeof messageId === "string"
      ? { threadId, messageId }
      : null;
  }
  if (method === "orchestration.launchThread") {
    const messageId = (record["initialMessage"] as { messageId?: unknown } | undefined)?.messageId;
    const threadId = (result as { threadId?: unknown } | null | undefined)?.threadId;
    return typeof threadId === "string" && typeof messageId === "string"
      ? { threadId, messageId }
      : null;
  }
  return null;
};
