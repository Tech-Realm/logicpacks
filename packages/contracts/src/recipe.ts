import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A Recipe is what kind of work a project is set up for: Code by default, or an
 * app on the host machine. It replaces v1 "packs" in everything users see.
 * Catalog, launch planning and op-log merge live in `@logicpacks/shared/recipes/*`.
 */
export const RECIPE_FORMAT_VERSION = "recipe/1" as const;
export const DEFAULT_RECIPE_ID = "code" as const;
export const RECIPE_MANIFEST_FILENAME = "recipe.json";
/** Committed in a project that uses a recipe other than Code, so Sync carries the choice. */
export const PROJECT_RECIPE_PATH = ".logicpacks/recipe.json";

export const RecipeId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  Schema.isMaxLength(64),
);
export type RecipeId = typeof RecipeId.Type;

/**
 * Where a recipe can run. `web` is the hosted browser build, which runs Code
 * only. `desktop` drives an app on the person's own machine. `cloud` runs the
 * app headless on the project's cloud host.
 */
export const RecipeSurface = Schema.Literals(["web", "desktop", "cloud"]);
export type RecipeSurface = typeof RecipeSurface.Type;

/**
 * `preview` works end to end with known gaps (Blender). `coming-soon`
 * manifests are real data, so the picker can show them, but nothing in them
 * runs: starting one is refused rather than attempted.
 */
export const RecipeAvailability = Schema.Literals(["available", "preview", "coming-soon"]);
export type RecipeAvailability = typeof RecipeAvailability.Type;

// ── App integration ─────────────────────────────────────────────────────────

export const RecipePlatform = Schema.Literals(["macos", "windows", "linux"]);
export type RecipePlatform = typeof RecipePlatform.Type;

export const RecipeApp = Schema.Struct({
  name: TrimmedNonEmptyString,
  vendor: Schema.optional(TrimmedNonEmptyString),
  homepage: Schema.optional(TrimmedNonEmptyString),
  download: Schema.optional(TrimmedNonEmptyString),
});
export type RecipeApp = typeof RecipeApp.Type;

/**
 * Where to look for the app on one platform. Paths are checked in order and may
 * start with `~/`; commands are looked up on PATH. The first hit wins.
 */
export const RecipeDetect = Schema.Struct({
  platform: RecipePlatform,
  paths: Schema.Array(TrimmedNonEmptyString),
  commands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type RecipeDetect = typeof RecipeDetect.Type;

/**
 * How to start the app on one platform. `{app}` is the detected path,
 * `{asset:<path>}` a file shipped with the recipe, `{session}` the session
 * directory, `{project}` the project folder and `{file}` the document being
 * opened (an argument that is exactly `{file}` is dropped when there is none).
 */
export const RecipeLaunch = Schema.Struct({
  platform: RecipePlatform,
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  /** Same, without a window: what the cloud host or a background agent runs. */
  headlessArgs: Schema.optional(Schema.Array(Schema.String)),
});
export type RecipeLaunch = typeof RecipeLaunch.Type;

export const RecipeAdapterKind = Schema.Literals(["socket-addon", "scripting-api", "cdp", "stdio"]);
export type RecipeAdapterKind = typeof RecipeAdapterKind.Type;

/**
 * How agents reach the adapter: an MCP server their provider session starts.
 * A `command` of `logicpacks` means this install's CLI. `{session}`, `{project}` and
 * `{asset:<path>}` are substituted as in `RecipeLaunch`.
 */
export const RecipeMcpServer = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
});
export type RecipeMcpServer = typeof RecipeMcpServer.Type;

/** The piece that turns the app's own API into something an agent can call. */
export const RecipeAdapter = Schema.Struct({
  kind: RecipeAdapterKind,
  summary: TrimmedNonEmptyString,
  /** Files the adapter needs, relative to the recipe's assets directory. */
  assets: Schema.Array(TrimmedNonEmptyString),
  mcp: Schema.optional(RecipeMcpServer),
});
export type RecipeAdapter = typeof RecipeAdapter.Type;

export const RecipeTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  status: Schema.Literals(["available", "coming-soon"]),
  /** Whether calling it changes the document, and so lands in the op log. */
  mutates: Schema.Boolean,
});
export type RecipeTool = typeof RecipeTool.Type;

/** What the op log records and how finely a merge can tell two edits apart. */
export const RecipeOpLogSpec = Schema.Struct({
  unit: TrimmedNonEmptyString,
  mergeGranularity: TrimmedNonEmptyString,
  snapshot: TrimmedNonEmptyString,
  recordedBy: TrimmedNonEmptyString,
});
export type RecipeOpLogSpec = typeof RecipeOpLogSpec.Type;

/** How an app recipe finds, starts and drives its app. Code needs none of this. */
export const RecipeIntegration = Schema.Struct({
  app: RecipeApp,
  platforms: Schema.NonEmptyArray(RecipePlatform),
  detect: Schema.Array(RecipeDetect),
  launch: Schema.Array(RecipeLaunch),
  adapter: RecipeAdapter,
  tools: Schema.Array(RecipeTool),
  opLog: RecipeOpLogSpec,
  /** Known gaps, said plainly. Shown on the recipe card. */
  limitations: Schema.Array(TrimmedNonEmptyString),
});
export type RecipeIntegration = typeof RecipeIntegration.Type;

// ── Portable context ────────────────────────────────────────────────────────

/**
 * Optional portable context a recipe file may carry: a ledger summary, decisions, references
 * into files and apps, and workflow steps. Nothing writes it any more (saved packs were
 * removed); it stays in the schema so older files still decode.
 */
export const RecipeContextReferenceKind = Schema.Literals([
  "file",
  "app-object",
  "timeline-marker",
  "url",
  "note",
]);
export type RecipeContextReferenceKind = typeof RecipeContextReferenceKind.Type;

export const RecipeContextReference = Schema.Struct({
  kind: RecipeContextReferenceKind,
  /** The app the reference lives in: "code", "blender", "davinci-resolve", "browser". */
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** A file path, an object name, a marker name or a URL. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  /** Type, timecode, activity: whatever helps another agent find it. */
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type RecipeContextReference = typeof RecipeContextReference.Type;

export const RecipeContextStep = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** The prompt that ran this step, to run it again elsewhere. */
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
  /** A step that runs in another recipe chains them: a Blender step feeding a Resolve step. */
  recipe: Schema.optional(RecipeId),
});
export type RecipeContextStep = typeof RecipeContextStep.Type;

export const RecipeContextDecision = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  by: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type RecipeContextDecision = typeof RecipeContextDecision.Type;

export const RecipeContextSource = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  projectTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  threadId: Schema.optional(TrimmedNonEmptyString),
  threadTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** The recipe the work happened in. */
  recipe: RecipeId,
  savedBy: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  savedAt: TrimmedNonEmptyString,
});
export type RecipeContextSource = typeof RecipeContextSource.Type;

export const RecipeContext = Schema.Struct({
  source: RecipeContextSource,
  /** The project ledger in a few lines: goal, who did what, where it stands. */
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  decisions: Schema.Array(RecipeContextDecision).check(Schema.isMaxLength(50)),
  references: Schema.Array(RecipeContextReference).check(Schema.isMaxLength(200)),
  steps: Schema.Array(RecipeContextStep).check(Schema.isMaxLength(50)),
});
export type RecipeContext = typeof RecipeContext.Type;

// ── The manifest ────────────────────────────────────────────────────────────

export const RecipeManifest = Schema.Struct({
  formatVersion: Schema.Literal(RECIPE_FORMAT_VERSION),
  id: RecipeId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  surfaces: Schema.NonEmptyArray(RecipeSurface),
  availability: RecipeAvailability,
  /** Host applications the recipe drives, by plain name ("blender", "davinci-resolve"). */
  apps: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** Written into the project's agent instructions when it is created with the recipe. */
  agentInstructions: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  starterPrompts: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  ),
  integration: Schema.optional(RecipeIntegration),
  /** Legacy portable context (see RecipeContext); read-only, nothing writes it. */
  context: Schema.optional(RecipeContext),
  /** Legacy: set on recipes converted from a v1 pack. */
  fromPack: Schema.optional(
    Schema.Struct({ name: TrimmedNonEmptyString, version: TrimmedNonEmptyString }),
  ),
});
export type RecipeManifest = typeof RecipeManifest.Type;

export const RecipeCatalog = Schema.Struct({
  defaultRecipeId: RecipeId,
  recipes: Schema.Array(RecipeManifest),
});
export type RecipeCatalog = typeof RecipeCatalog.Type;

/** `.logicpacks/recipe.json` in a project. No file means the project is Code. */
export const ProjectRecipeFile = Schema.Struct({ recipe: RecipeId });
export type ProjectRecipeFile = typeof ProjectRecipeFile.Type;

/** Recipes a surface can start now. The web client offers Code only and points to the desktop app. */
export const recipesForSurface = (
  recipes: ReadonlyArray<RecipeManifest>,
  surface: RecipeSurface,
): ReadonlyArray<RecipeManifest> =>
  recipes.filter(
    (candidate) => candidate.availability !== "coming-soon" && candidate.surfaces.includes(surface),
  );
