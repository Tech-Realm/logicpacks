/**
 * How `lp inbox` and `lp agents` read to an agent: one entry per item, its id, what it
 * is, and the commands that act on it, so any harness can surface host-side alerts.
 */

export type InboxItem =
  | {
      readonly kind: "ask" | "reply" | "notice";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly from: string;
      readonly fromThreadId: string | null;
      readonly toThreadId: string;
      readonly replyTo: string | null;
      readonly text: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "conflict";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly files: ReadonlyArray<string>;
      readonly people: ReadonlyArray<string>;
      readonly reason: string;
      readonly threadId: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "negotiation";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly state: string;
      readonly files: ReadonlyArray<string>;
      readonly people: ReadonlyArray<string>;
      readonly question: string | null;
      readonly needsPosition: boolean;
      readonly threadId: string;
      readonly atMs: number;
    }
  | {
      /** Goals: drift and review requests to decide, milestones for you, drafts to confirm. */
      readonly kind: "drift" | "review" | "milestone" | "goal";
      readonly id: string;
      readonly goalId?: string;
      readonly actions?: ReadonlyArray<string>;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly person: string;
      readonly text: string;
      readonly atMs: number;
    };

export interface AgentEntry {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string;
  readonly title: string;
  readonly person: string | null;
  readonly personId: string | null;
  readonly harness: string;
  readonly model: string | null;
  readonly task: string | null;
  readonly status: string;
  readonly files: ReadonlyArray<string>;
  readonly lastActiveAtMs: number;
}

export const ago = (atMs: number, nowMs: number) => {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const quote = (text: string) => JSON.stringify(text);

/** The first word of a display name, as `lp send` takes it. */
const handle = (name: string) => name.replace(/\s*\(from .*\)$/, "").split(/\s+/)[0] ?? name;

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/** The commands that act on one item. */
export const nextCommands = (item: InboxItem): ReadonlyArray<string> => {
  switch (item.kind) {
    case "ask":
      return [
        `lp reply ${item.id} ${quote("<your answer>")}`,
        `lp who ${handle(item.from)}`,
        `lp done ${item.id}`,
      ];
    case "reply":
      return [`lp reply ${item.id} ${quote("<follow-up>")}`, `lp done ${item.id}`];
    case "notice":
      return [`lp send ${handle(item.from)} ${quote("<message>")}`, `lp done ${item.id}`];
    case "conflict":
      return [
        `lp who ${item.files[0] ?? item.people[0] ?? ""}`.trim(),
        ...(item.people[0] ? [`lp ask ${handle(item.people[0])} ${quote("<how to merge>")}`] : []),
      ];
    case "negotiation":
      return item.question !== null
        ? [`lp decide ${item.id} accept|mine|theirs|both   (ask your user first)`]
        : item.needsPosition
          ? [`lp reply ${item.id} ${quote("<why>")} --keep "<a,b>" --change "<c>" --drop "<d>"`]
          : [`lp inbox --all`];
    case "drift":
      return [
        `lp goals decide ${item.id} message --note ${quote("<what to change>")}   (ask your user first)`,
        `lp goals decide ${item.id} accept|ignore`,
        `lp agents   (watch what ${handle(item.person)} is on)`,
      ];
    case "review":
      return [
        `lp goals show ${item.goalId ?? item.id}`,
        `lp goals decide ${item.id} approve   (ask your user first)`,
        `lp goals decide ${item.id} changes --note ${quote("<what to fix>")}`,
      ];
    case "milestone":
      return [
        `lp goals start ${item.id}`,
        `lp goals done ${item.id} --note ${quote("<what you did>")}`,
        `lp goals blocked ${item.id} --note ${quote("<why>")}`,
      ];
    case "goal":
      return [
        `lp goals show ${item.id}`,
        `lp goals confirm ${item.id}   (after your user agrees; this sends the milestones)`,
        `lp goals cancel ${item.id}`,
      ];
  }
};

const headline = (item: InboxItem, nowMs: number) => {
  const when = ago(item.atMs, nowMs);
  switch (item.kind) {
    case "ask":
      return `[${item.id}] question from ${item.from} (${item.projectTitle}, ${when})`;
    case "reply":
      return `[${item.id}] reply from ${item.from} (${item.projectTitle}, ${when})`;
    case "notice":
      return `[${item.id}] message from ${item.from} (${item.projectTitle}, ${when})`;
    case "conflict":
      return `[${item.id}] conflict in ${item.files.join(", ") || "files"} with ${item.people.join(" and ") || "a teammate"} (${item.projectTitle}, ${when})`;
    case "negotiation":
      return `[${item.id}] merge negotiation, ${item.state.replaceAll("_", " ")}, with ${item.people.join(", ")} (${item.projectTitle}, ${when})`;
    case "drift":
      return `[${item.id}] drift: ${item.person} is off the plan (${item.projectTitle}, ${when})`;
    case "review":
      return `[${item.id}] review requested by ${item.person} (${item.projectTitle}, ${when})`;
    case "milestone":
      return `[${item.id}] milestone for you from ${item.person} (${item.projectTitle}, ${when})`;
    case "goal":
      return `[${item.id}] draft goal to confirm (${item.projectTitle}, ${when})`;
  }
};

const detail = (item: InboxItem) => {
  switch (item.kind) {
    case "ask":
    case "reply":
    case "notice":
    case "drift":
    case "review":
    case "milestone":
    case "goal":
      return item.text;
    case "conflict":
      return item.reason;
    case "negotiation":
      return (
        item.question ??
        (item.needsPosition ? "Your agent's position is needed." : "Waiting on the others.")
      );
  }
};

export const formatInboxItem = (item: InboxItem, nowMs: number) =>
  [
    headline(item, nowMs),
    indent(detail(item)),
    `    next: ${nextCommands(item).join("  |  ")}`,
  ].join("\n");

export const formatInbox = (items: ReadonlyArray<InboxItem>, nowMs: number) =>
  items.length === 0
    ? "Inbox is empty."
    : [
        `${items.length} item${items.length === 1 ? "" : "s"} for you:`,
        "",
        items.map((item) => formatInboxItem(item, nowMs)).join("\n\n"),
      ].join("\n");

export const formatAgents = (
  agents: ReadonlyArray<AgentEntry>,
  ownThreadId: string | null,
  nowMs: number,
) => {
  if (agents.length === 0) return "Nobody else is working here right now.";
  const multiProject = new Set(agents.map((agent) => agent.projectId)).size > 1;
  return agents
    .map((agent) => {
      const who = agent.person ?? "Someone";
      const task = agent.task ? `: ${agent.task}` : "";
      const files = agent.files.length > 0 ? ` (files: ${agent.files.join(", ")})` : "";
      const where = multiProject ? ` in ${agent.projectTitle}` : "";
      const you = agent.threadId === ownThreadId ? " (you)" : "";
      return `${who}${you} via ${agent.harness}${where}, ${agent.status}, ${ago(agent.lastActiveAtMs, nowMs)}${task}${files}\n    thread ${agent.threadId}`;
    })
    .join("\n");
};
