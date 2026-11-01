// @effect-diagnostics preferSchemaOverJson:off -- prefs are opaque client JSON, validated by the web app.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Per-person preferences that follow the account: the layout modes, the answer to the
 * sign-in "How do you work?" question, and the intro and tour state. The server stores
 * each key as JSON and only checks its name and size; the web app owns the shapes.
 *
 * `workStyle` is the shared key the onboarding writes ("developer" or "beginner").
 */
export const USER_PREF_KEYS = ["layout", "workStyle", "intro"] as const;
export type UserPrefKey = (typeof USER_PREF_KEYS)[number];

const MAX_VALUE_BYTES = 12 * 1024;

/** The host operator has no user id; their prefs live under one fixed owner. */
export const OPERATOR_PREFS_OWNER = "operator";

export class UserPrefsError extends Schema.TaggedError<UserPrefsError>()("UserPrefsError", {
  reason: Schema.Literals(["invalid", "storage"]),
  message: Schema.String,
}) {}

const storage = (cause: unknown) =>
  new UserPrefsError({ reason: "storage", message: `Prefs storage failed: ${String(cause)}` });

/** Validates a patch: known keys only, `null` clears a key, `workStyle` is one of two answers. */
export function validatePrefsPatch(patch: Readonly<Record<string, unknown>>):
  | { readonly ok: true; readonly entries: ReadonlyArray<readonly [UserPrefKey, string | null]> }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const entries: Array<readonly [UserPrefKey, string | null]> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(USER_PREF_KEYS as ReadonlyArray<string>).includes(key))
      return { ok: false, message: `Unknown preference "${key}".` };
    if (value === null) {
      entries.push([key as UserPrefKey, null]);
      continue;
    }
    if (key === "workStyle" && value !== "developer" && value !== "beginner")
      return { ok: false, message: 'workStyle is "developer" or "beginner".' };
    const json = JSON.stringify(value);
    if (json === undefined) return { ok: false, message: `"${key}" has no JSON value.` };
    if (json.length > MAX_VALUE_BYTES) return { ok: false, message: `"${key}" is too large.` };
    entries.push([key as UserPrefKey, json]);
  }
  return { ok: true, entries };
}

const ensureTable = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS logicpacks_user_prefs (
    owner TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, key)
  )`;

export const readUserPrefs = Effect.fn("logicpacks.prefs.read")(function* (owner: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTable(sql).pipe(Effect.mapError(storage));
  const rows = yield* sql<{ readonly key: string; readonly value: string }>`
    SELECT key, value FROM logicpacks_user_prefs WHERE owner = ${owner}
  `.pipe(Effect.mapError(storage));
  return prefsFromRows(rows);
});

function prefsFromRows(rows: ReadonlyArray<{ readonly key: string; readonly value: string }>) {
  const prefs: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      prefs[row.key] = JSON.parse(row.value);
    } catch {
      // A row that does not parse reads as unset.
    }
  }
  return prefs;
}

export const writeUserPrefs = Effect.fn("logicpacks.prefs.write")(function* (
  owner: string,
  patch: Readonly<Record<string, unknown>>,
) {
  const checked = validatePrefsPatch(patch);
  if (!checked.ok)
    return yield* new UserPrefsError({ reason: "invalid", message: checked.message });
  const sql = yield* SqlClient.SqlClient;
  yield* ensureTable(sql).pipe(Effect.mapError(storage));
  const updatedAt = DateTime.formatIso(yield* DateTime.now);
  for (const [key, value] of checked.entries) {
    yield* (
      value === null
        ? sql`DELETE FROM logicpacks_user_prefs WHERE owner = ${owner} AND key = ${key}`
        : sql`
            INSERT INTO logicpacks_user_prefs (owner, key, value, updated_at)
            VALUES (${owner}, ${key}, ${value}, ${updatedAt})
            ON CONFLICT (owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `
    ).pipe(Effect.mapError(storage));
  }
});
