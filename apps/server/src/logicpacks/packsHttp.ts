import { PROJECT_PACKS_DIR, type ProjectId, type RecipeManifest } from "@logicpacks/contracts";
import {
  decodePack,
  encodePack,
  packFromThread,
  packHandoffText,
  packPath,
  renderPackContext,
} from "@logicpacks/shared/recipes/packContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  actorOf,
  json,
  queryParam,
  readBody,
  resolveCaller,
  usageCallerOf,
  type Caller,
} from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { LogicPacksUsage } from "./LogicPacksUsage.ts";
import { featureGate } from "./featureHttp.ts";
import { packKey } from "./packCredits.ts";
import { LedgerError, ProjectLedger } from "./ProjectLedger.ts";
import { readProjectRecipe } from "./projectRecipe.ts";

/**
 * Packs carry context between threads, apps and projects: a thread saved as a pack is a
 * `recipe/1` manifest committed at `.logicpacks/packs/<id>.json`, so Sync carries it.
 * "Use in..." hands it to a thread through the ledger or copies it into another project.
 */

const projectRoot = Effect.fn("logicpacks.packs.projectRoot")(function* (projectId: string) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(shell)
    ? { root: shell.value.workspaceRoot, title: shell.value.title }
    : null;
});

/** Every pack saved in a project, newest file order; files that do not decode are skipped. */
export const readProjectPacks = Effect.fn("logicpacks.packs.read")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, PROJECT_PACKS_DIR);
  const names = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const packs: Array<RecipeManifest> = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const text = yield* fileSystem
      .readFileString(path.join(dir, name))
      .pipe(Effect.orElseSucceed(() => ""));
    const pack = decodePack(text);
    if (pack !== null) packs.push(pack);
  }
  return packs;
});

const writePack = Effect.fn("logicpacks.packs.write")(function* (
  root: string,
  pack: RecipeManifest,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(root, PROJECT_PACKS_DIR), { recursive: true });
  yield* fileSystem.writeFileString(path.join(root, packPath(pack.id)), encodePack(pack));
});

/** A pack id not taken yet in this project: `name`, `name-2`, ... */
const freeId = (taken: ReadonlySet<string>, id: string) => {
  if (!taken.has(id)) return id;
  for (let index = 2; ; index += 1) {
    const candidate = `${id.slice(0, 60)}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const canUse = Effect.fn("logicpacks.packs.canUse")(function* (caller: Caller, projectId: string) {
  if (caller.kind === "operator") return true;
  if (caller.kind !== "member") return false;
  const access = yield* LogicPacksAccess;
  return access.roleOf(caller.userId, projectId) !== null;
});

/**
 * Feeds publishing and reuse into usage and achievements. Never fails the pack action:
 * a pack that was saved or handed over stays saved even if the tally cannot be written.
 */
const credit = Effect.fn("logicpacks.packs.credit")(
  function* <A, E>(
    caller: Caller,
    record: (
      usage: LogicPacksUsage["Service"],
      participantId: string,
    ) => Effect.Effect<ReadonlyArray<A>, E>,
  ) {
    const participant = usageCallerOf(caller);
    const usage = yield* Effect.serviceOption(LogicPacksUsage);
    if (participant === null || Option.isNone(usage)) return [];
    return yield* record(usage.value, participant.participantId);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("LogicPacks could not credit a pack", { cause }).pipe(Effect.as([])),
  ),
);

const signedIn = Effect.gen(function* () {
  const caller = yield* resolveCaller;
  return caller.kind === "anonymous" ? null : caller;
});
const unauthenticated = json({ error: "unauthenticated" }, 401);
const notFound = json({ error: "not_found", message: "Not found." }, 404);
const ledgerError = (error: LedgerError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, error.reason === "not_found" ? 404 : 409),
  );

/** What the context view shows for a pack: the manifest and the text an agent reads. */
const view = (pack: RecipeManifest) => ({
  pack,
  text:
    pack.context === undefined
      ? null
      : renderPackContext({ name: pack.name, context: pack.context }),
});

const listRoute = HttpRouter.add(
  "GET",
  "/api/lp/packs",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("packs");
    if (locked !== null) return locked;
    const projectId = yield* queryParam("projectId");
    if (!(yield* canUse(caller, projectId))) return notFound;
    const project = yield* projectRoot(projectId);
    if (project === null) return notFound;
    const packs = yield* readProjectPacks(project.root);
    return json({ projectId, packs: packs.map(view) });
  }),
);

const SaveBody = Schema.Struct({
  threadId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** The thread's prompts, oldest first, from the client that shows the thread. */
  prompts: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(8_000)))),
  /** Items of the app's outline the client shows (Blender objects, Resolve markers). */
  appItems: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["app-object", "timeline-marker"]),
        name: Schema.String,
        detail: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/** Save a thread as a pack: its ledger entry, the project's decisions, its prompts as steps. */
const saveRoute = HttpRouter.add(
  "POST",
  "/api/lp/packs/save",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("packs");
    if (locked !== null) return locked;
    const body = yield* readBody(SaveBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const ledger = yield* ProjectLedger;
    const projectId = yield* ledger.projectOfThread(body.threadId);
    if (projectId === null || !(yield* canUse(caller, projectId))) return notFound;
    const project = yield* projectRoot(projectId);
    if (project === null) return notFound;
    const ledgerView = yield* ledger.view(projectId);
    const thread = ledgerView.threads.find((candidate) => candidate.threadId === body.threadId);
    const recipe = yield* readProjectRecipe(project.root);
    const savedBy = yield* ledger.personName(caller.kind === "member" ? caller.userId : "host");
    const now = yield* DateTime.now;
    const existing = yield* readProjectPacks(project.root);
    const built = packFromThread({
      projectId,
      projectTitle: project.title,
      threadId: body.threadId,
      threadTitle: thread?.title ?? "Thread",
      recipe: recipe.id,
      savedBy,
      savedAt: DateTime.formatIso(now),
      goal: thread?.goal ?? null,
      branch: thread?.branch ?? null,
      people: thread?.members.map((member) => member.name) ?? [savedBy],
      files: thread?.files.map((file) => ({ path: file.path, activity: file.activity })) ?? [],
      decisions: ledgerView.decisions
        .filter((decision) => decision.threadId === null || decision.threadId === body.threadId)
        .map((decision) => ({ text: decision.text, by: decision.by })),
      prompts: (body.prompts ?? []).slice(-40),
      appItems: (body.appItems ?? []).slice(0, 80),
      name: body.name,
    });
    const pack = {
      ...built,
      id: freeId(new Set(existing.map((candidate) => candidate.id)), built.id),
    };
    yield* writePack(project.root, pack);
    yield* ledger
      .note({ threadId: body.threadId, decision: `Saved as pack "${pack.name}".`, by: savedBy })
      .pipe(Effect.ignore);
    const unlocked = yield* credit(caller, (usage, authorId) =>
      usage.recordPackPublished({ authorId, key: packKey(pack), projectId }),
    );
    return json({ ...view(pack), unlocked }, 201);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(json({ error: "save_failed", message: String(error.message ?? error) }, 500)),
    ),
  ),
);

const UseBody = Schema.Struct({
  projectId: Schema.String,
  packId: Schema.String,
  /** A thread to hand the context to: its agent reads it on its next turn. */
  targetThreadId: Schema.optionalKey(Schema.String),
  /** Another project to copy the pack into. */
  targetProjectId: Schema.optionalKey(Schema.String),
});

/** "Use in…": hand a pack's context to a thread, here or in another project or app. */
const useRoute = HttpRouter.add(
  "POST",
  "/api/lp/packs/use",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("packs");
    if (locked !== null) return locked;
    const body = yield* readBody(UseBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (!(yield* canUse(caller, body.projectId))) return notFound;
    const source = yield* projectRoot(body.projectId);
    if (source === null) return notFound;
    const pack = (yield* readProjectPacks(source.root)).find(
      (candidate) => candidate.id === body.packId,
    );
    if (pack === undefined || pack.context === undefined) return notFound;
    const ledger = yield* ProjectLedger;
    const targetProjectId =
      body.targetThreadId !== undefined
        ? yield* ledger.projectOfThread(body.targetThreadId)
        : (body.targetProjectId ?? null);
    if (targetProjectId === null || !(yield* canUse(caller, targetProjectId))) return notFound;
    const target = yield* projectRoot(targetProjectId);
    if (target === null) return notFound;
    let copied = false;
    if (targetProjectId !== body.projectId) {
      const theirs = yield* readProjectPacks(target.root);
      if (!theirs.some((candidate) => candidate.id === pack.id)) {
        yield* writePack(target.root, pack);
        copied = true;
      }
    }
    let delivered: string | null = null;
    if (body.targetThreadId !== undefined) {
      const targetRecipe = yield* readProjectRecipe(target.root);
      const message = yield* ledger.send({
        projectId: targetProjectId,
        fromThreadId: null,
        fromName: `${yield* ledger.personName(caller.kind === "member" ? caller.userId : "host")} (pack ${pack.name})`,
        to: body.targetThreadId,
        text: packHandoffText({ name: pack.name, context: pack.context }, targetRecipe.id),
      });
      delivered = message.id;
    }
    const unlocked = yield* credit(caller, (usage, reuserId) =>
      usage.recordPackReused({
        reuserId,
        key: packKey(pack),
        useId: delivered ?? `copy:${targetProjectId}`,
        projectId: targetProjectId,
      }),
    );
    return json({
      copied,
      delivered,
      targetProjectId,
      by: actorOf(caller),
      unlocked,
    });
  }).pipe(
    Effect.catchTags({ LedgerError: ledgerError }),
    Effect.catch((error) =>
      Effect.succeed(
        json({ error: "use_failed", message: String((error as Error).message ?? error) }, 500),
      ),
    ),
  ),
);

/** The `packs` ledger tool: list a project's packs, or read one pack's full context. */
export const packsToolText = Effect.fn("logicpacks.packs.tool")(function* (
  projectId: string,
  packId: string | undefined,
) {
  const project = yield* projectRoot(projectId);
  if (project === null) return "This project has no folder on the host.";
  const packs = yield* readProjectPacks(project.root);
  if (packs.length === 0) {
    return "No packs saved in this project yet. Save a thread as a pack from its header.";
  }
  const wanted = packId?.trim();
  if (wanted) {
    const pack = packs.find(
      (candidate) =>
        candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (pack === undefined) {
      return `No pack "${wanted}". Packs here: ${packs.map((candidate) => candidate.id).join(", ")}.`;
    }
    return pack.context === undefined
      ? `${pack.name}: ${pack.summary}\n${pack.agentInstructions ?? ""}`
      : renderPackContext({ name: pack.name, context: pack.context });
  }
  return [
    "Packs in this project (read one with query set to its id):",
    ...packs.map(
      (pack) =>
        `- ${pack.id}: ${pack.name}. ${pack.summary}${pack.context ? ` [${pack.context.decisions.length} decisions, ${pack.context.references.length} references, ${pack.context.steps.length} steps]` : ""}`,
    ),
  ].join("\n");
});

/** Reads packs without the caller providing the file system: for the MCP ledger tools. */
export type PacksReader = (projectId: string, query: string | undefined) => Effect.Effect<string>;
export const packsReader = Effect.gen(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // Optional so a toolkit built without projects (tests) still builds.
  const store = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const read: PacksReader = (projectId, query) =>
    Option.isNone(store)
      ? Effect.succeed("Packs are not available here.")
      : packsToolText(projectId, query).pipe(
          Effect.provideService(ProjectStore.ProjectStoreV2, store.value),
          Effect.provide(context),
        );
  return read;
});

export const layer = Layer.mergeAll(listRoute, saveRoute, useRoute);
