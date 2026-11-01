/**
 * Portable pack context: a thread saved as a pack, and the text an agent in
 * another app or thread reads back. Pure functions, so the round trip
 * (save, encode, decode, render) is unit-tested without a server.
 */
import {
  PROJECT_PACKS_DIR,
  RECIPE_FORMAT_VERSION,
  RecipeManifest,
  type RecipeContext,
  type RecipeContextReference,
  type RecipeContextStep,
} from "@logicpacks/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface PackThreadInput {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string;
  readonly threadTitle: string;
  /** The recipe of the project the thread is in ("code", "blender"). */
  readonly recipe: string;
  readonly savedBy: string;
  readonly savedAt: string;
  /** The ledger's view of the thread. */
  readonly goal: string | null;
  readonly branch: string | null;
  readonly people: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly activity: string }>;
  readonly decisions: ReadonlyArray<{ readonly text: string; readonly by: string }>;
  /** What people asked for, oldest first. They become the workflow steps. */
  readonly prompts: ReadonlyArray<string>;
  /** Items from the app's outline: a Blender object list, Resolve timeline markers. */
  readonly appItems?: ReadonlyArray<{
    readonly kind: "app-object" | "timeline-marker";
    readonly name: string;
    readonly detail?: string | undefined;
  }>;
  readonly name?: string | undefined;
}

const MAX_STEPS = 12;
const MAX_REFERENCES = 120;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();
const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A recipe id from a name: lower case, dashes, at most 64 characters. */
export const packIdFromName = (name: string): string => {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return id.length === 0 ? "pack" : id;
};

/** Where a pack lives in its project. */
export const packPath = (packId: string) => `${PROJECT_PACKS_DIR}/${packId}.json`;

const stripContextBlocks = (text: string) =>
  text.replace(/<logicpacks_[a-z_]+>[\s\S]*?<\/logicpacks_[a-z_]+>/g, "").trim();

/** A step title from a prompt: its first sentence, without greetings. */
export const stepTitle = (prompt: string): string => {
  const firstLine =
    stripContextBlocks(prompt)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  let rest = firstLine;
  for (let previous = ""; previous !== rest;) {
    previous = rest;
    rest = rest.replace(/^(hi|hey|hello|ok|okay|so|please|now)\b[,!.\s]*/i, "");
  }
  const sentence = (rest.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? rest).replace(/[.!?]+$/, "");
  return clip(sentence.length === 0 ? "Step" : sentence[0]!.toUpperCase() + sentence.slice(1), 200);
};

const fileApp = (recipe: string, path: string) => {
  if (/\.blend\d?$/i.test(path)) return "blender";
  if (/\.(drp|drt|edl|fcpxml)$/i.test(path)) return "davinci-resolve";
  return recipe === "code" ? "code" : recipe;
};

const summaryOf = (input: PackThreadInput) => {
  const who = input.people.length === 0 ? "Someone" : input.people.join(", ");
  const lines = [
    `${who} worked in "${input.threadTitle}" (${input.projectTitle}).`,
    input.goal === null ? null : `Goal: ${clip(input.goal, 300)}`,
    input.branch === null ? null : `Branch: ${input.branch}`,
    input.files.length === 0
      ? null
      : `Touched: ${input.files
          .slice(0, 6)
          .map((file) => file.path)
          .join(", ")}${input.files.length > 6 ? ` and ${input.files.length - 6} more` : ""}`,
    input.decisions.length === 0 ? null : `${input.decisions.length} decision(s) recorded.`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
};

/** Builds the pack a thread saves: a `recipe/1` manifest with its portable context. */
export const packFromThread = (input: PackThreadInput): RecipeManifest => {
  const name = clip(input.name?.trim() || input.threadTitle || "Saved thread", 64);
  const references: Array<RecipeContextReference> = [
    ...input.files.map((file) => ({
      kind: "file" as const,
      app: fileApp(input.recipe, file.path),
      name: clip(file.path, 400),
      detail: file.activity,
    })),
    ...(input.appItems ?? []).map((item) => ({
      kind: item.kind,
      app: input.recipe,
      name: clip(item.name, 400),
      ...(item.detail === undefined || item.detail.trim() === ""
        ? {}
        : { detail: clip(item.detail, 400) }),
    })),
  ].slice(0, MAX_REFERENCES);
  const prompts = input.prompts.map(stripContextBlocks).filter((prompt) => prompt.length > 0);
  const steps: Array<RecipeContextStep> = prompts.slice(-MAX_STEPS).map((prompt) => ({
    title: stepTitle(prompt),
    prompt: prompt.slice(0, 4_000),
    recipe: input.recipe,
  }));
  const context: RecipeContext = {
    source: {
      projectId: input.projectId,
      projectTitle: clip(input.projectTitle, 200),
      threadId: input.threadId,
      threadTitle: clip(input.threadTitle || "Thread", 200),
      recipe: input.recipe,
      savedBy: clip(input.savedBy, 120),
      savedAt: input.savedAt,
    },
    summary: summaryOf(input).slice(0, 4_000),
    decisions: input.decisions.slice(-50).map((decision) => ({
      text: clip(decision.text, 600),
      by: clip(decision.by, 120),
    })),
    references,
    steps,
  };
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    id: packIdFromName(name),
    name,
    summary: clip(
      input.goal ?? `Context from "${input.threadTitle}" in ${input.projectTitle}.`,
      200,
    ),
    surfaces: ["web", "desktop", "cloud"],
    availability: "available",
    apps: Array.from(new Set(references.map((reference) => reference.app))).slice(0, 8),
    agentInstructions: renderPackContext({ name, context }).slice(0, 8_000),
    context,
  };
};

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(RecipeManifest));
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(RecipeManifest));

/** The committed file: pretty JSON. */
export const encodePack = (pack: RecipeManifest): string =>
  `${JSON.stringify(JSON.parse(encodeManifest(pack)), null, 2)}\n`;

export const decodePack = (text: string): RecipeManifest | null =>
  Option.getOrNull(decodeManifest(text));

const APP_LABEL: Record<string, string> = {
  code: "Code",
  blender: "Blender",
  "davinci-resolve": "DaVinci Resolve",
  browser: "Browser",
};
export const appLabel = (app: string) => APP_LABEL[app] ?? app;

/** References grouped by app, in first-seen order. */
export const referencesByApp = (references: ReadonlyArray<RecipeContextReference>) => {
  const groups = new Map<string, Array<RecipeContextReference>>();
  for (const reference of references) {
    const list = groups.get(reference.app) ?? [];
    list.push(reference);
    groups.set(reference.app, list);
  }
  return Array.from(groups, ([app, items]) => ({ app, items }));
};

/**
 * The text an agent reads: what the pack is, where it came from, what was
 * decided, what it points at in which app, and the steps to repeat.
 */
export const renderPackContext = (pack: {
  readonly name: string;
  readonly context: RecipeContext;
}): string => {
  const { context } = pack;
  const source = context.source;
  const lines = [
    `Pack "${pack.name}" from ${source.threadTitle ? `thread "${source.threadTitle}" in ` : ""}${source.projectTitle} (${appLabel(source.recipe)}), saved by ${source.savedBy}.`,
    "",
    context.summary,
  ];
  if (context.decisions.length > 0) {
    lines.push("", "Decisions:", ...context.decisions.map((d) => `- ${d.text} (${d.by})`));
  }
  if (context.references.length > 0) {
    lines.push("", "References:");
    for (const group of referencesByApp(context.references)) {
      lines.push(
        `${appLabel(group.app)}:`,
        ...group.items.map(
          (item) => `- ${item.kind} ${item.name}${item.detail ? ` (${item.detail})` : ""}`,
        ),
      );
    }
  }
  if (context.steps.length > 0) {
    lines.push(
      "",
      "Workflow:",
      ...context.steps.map(
        (step, index) =>
          `${index + 1}. ${step.title}${step.recipe && step.recipe !== source.recipe ? ` [${appLabel(step.recipe)}]` : ""}`,
      ),
    );
  }
  return lines.join("\n");
};

/** The message a target thread receives when a pack is used there. */
export const packHandoffText = (
  pack: {
    readonly name: string;
    readonly context: RecipeContext;
  },
  targetApp: string,
): string =>
  clip(
    `Use the context of pack "${pack.name}" here (${appLabel(targetApp)}). Read it in full with the packs tool. ${pack.context.summary}`,
    600,
  ) +
  (pack.context.decisions.length > 0
    ? `\nDecisions: ${pack.context.decisions
        .slice(-5)
        .map((decision) => decision.text)
        .join("; ")}`
    : "");

/** Chains two packs into one workflow: the first's steps, then the second's. */
export const chainPacks = (first: RecipeManifest, second: RecipeManifest): RecipeContextStep[] => [
  ...(first.context?.steps ?? []).map((step) => ({ ...step, recipe: step.recipe ?? first.id })),
  ...(second.context?.steps ?? []).map((step) => ({ ...step, recipe: step.recipe ?? second.id })),
];
