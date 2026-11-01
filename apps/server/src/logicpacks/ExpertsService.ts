// @effect-diagnostics preferSchemaOverJson:off -- rows hold the plain JSON of the experts.ts shapes.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  grantAllows,
  grantedInstanceIds,
  SEED_VERSION,
  planSeed,
  type AssistanceRequest,
  type Expert,
  type ProviderGrant,
} from "./experts.ts";

export class ExpertsError extends Schema.TaggedError<ExpertsError>()("ExpertsError", {
  reason: Schema.Literals(["not_found", "invalid", "forbidden", "storage"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const storage = (operation: string) => (cause: unknown) =>
  new ExpertsError({
    reason: "storage",
    message: `Experts storage failed during ${operation}.`,
    cause,
  });

/**
 * The expert catalog, assistance requests and provider grants. Rows hold JSON so the
 * shapes in `experts.ts` stay the one definition; one process owns the database, so the
 * in-memory maps are authoritative and the fence can read grants synchronously.
 */
export class ExpertsService extends Context.Service<
  ExpertsService,
  {
    readonly experts: () => ReadonlyArray<Expert>;
    readonly expert: (id: string) => Expert | undefined;
    readonly putExpert: (expert: Expert) => Effect.Effect<void, ExpertsError>;
    readonly removeExpert: (id: string) => Effect.Effect<boolean, ExpertsError>;
    readonly requests: () => ReadonlyArray<AssistanceRequest>;
    readonly request: (id: string) => AssistanceRequest | undefined;
    readonly putRequest: (request: AssistanceRequest) => Effect.Effect<void, ExpertsError>;
    readonly grants: () => ReadonlyArray<ProviderGrant>;
    readonly putGrant: (grant: ProviderGrant) => Effect.Effect<void, ExpertsError>;
    /** Synchronous so the RPC fence can ask per turn. */
    readonly allows: (
      granteeUserId: string,
      instanceId: string,
      projectId: string | null,
    ) => boolean;
    readonly grantedInstanceIds: (granteeUserId: string) => ReadonlySet<string>;
    /**
     * Account deletion: drops the grants this user gave or holds and the assistance requests
     * they made or took. With `dryRun` only counts.
     */
    readonly forgetUser: (
      userId: string,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<{ readonly grants: number; readonly requests: number }, ExpertsError>;
    /** A deleted project's grants and requests. */
    readonly forgetProject: (
      projectId: string,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<{ readonly grants: number; readonly requests: number }, ExpertsError>;
  }
>()("logicpacks/logicpacks/ExpertsService") {}

const ensureSchema = (sql: SqlClient.SqlClient) =>
  Effect.all(
    [
      sql`CREATE TABLE IF NOT EXISTS logicpacks_experts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS logicpacks_expert_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS logicpacks_provider_grants (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS logicpacks_experts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ],
    { discard: true },
  );

const load = <A>(sql: SqlClient.SqlClient, table: "experts" | "requests" | "grants") => {
  const query =
    table === "experts"
      ? sql<{ readonly id: string; readonly data: string }>`SELECT id, data FROM logicpacks_experts`
      : table === "requests"
        ? sql<{
            readonly id: string;
            readonly data: string;
          }>`SELECT id, data FROM logicpacks_expert_requests`
        : sql<{
            readonly id: string;
            readonly data: string;
          }>`SELECT id, data FROM logicpacks_provider_grants`;
  return query.pipe(
    Effect.map((rows) => {
      const map = new Map<string, A>();
      for (const row of rows) {
        try {
          map.set(row.id, JSON.parse(row.data) as A);
        } catch {
          // A row that does not parse is skipped rather than failing the server.
        }
      }
      return map;
    }),
    Effect.mapError(storage(`loading ${table}`)),
  );
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));
  const experts = yield* load<Expert>(sql, "experts");
  const requests = yield* load<AssistanceRequest>(sql, "requests");
  const grants = yield* load<ProviderGrant>(sql, "grants");

  const putExpert = (expert: Expert) =>
    sql`
      INSERT INTO logicpacks_experts (id, data) VALUES (${expert.id}, ${JSON.stringify(expert)})
      ON CONFLICT (id) DO UPDATE SET data = excluded.data
    `.pipe(
      Effect.mapError(storage("saving an expert")),
      Effect.tap(() => Effect.sync(() => experts.set(expert.id, expert))),
      Effect.asVoid,
    );

  // The seed goes in once. An operator who deletes a sample profile does not get it back.
  // Marker "2" adds the profiles that came after the first seed and swaps the old drawn
  // portraits of untouched sample profiles for the photo ones.
  const seeded = yield* sql<{ readonly value: string }>`
    SELECT value FROM logicpacks_experts_meta WHERE key = 'seeded'
  `.pipe(Effect.mapError(storage("reading the seed marker")));
  const seedVersion = seeded[0]?.value ?? "0";
  if (seedVersion !== SEED_VERSION) {
    const plan = planSeed([...experts.values()], seedVersion);
    for (const expert of plan) yield* putExpert(expert);
    yield* sql`
      INSERT INTO logicpacks_experts_meta (key, value) VALUES ('seeded', ${SEED_VERSION})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `.pipe(Effect.mapError(storage("writing the seed marker")));
  }

  const forget = Effect.fn("ExpertsService.forget")(function* (
    grantMatches: (grant: ProviderGrant) => boolean,
    requestMatches: (request: AssistanceRequest) => boolean,
    dryRun: boolean,
  ) {
    const grantIds = Array.from(grants.values())
      .filter(grantMatches)
      .map((grant) => grant.id);
    const requestIds = Array.from(requests.values())
      .filter(requestMatches)
      .map((request) => request.id);
    if (!dryRun) {
      for (const id of grantIds) {
        yield* sql`DELETE FROM logicpacks_provider_grants WHERE id = ${id}`.pipe(
          Effect.mapError(storage("removing a grant")),
        );
        grants.delete(id);
      }
      for (const id of requestIds) {
        yield* sql`DELETE FROM logicpacks_expert_requests WHERE id = ${id}`.pipe(
          Effect.mapError(storage("removing a request")),
        );
        requests.delete(id);
      }
    }
    return { grants: grantIds.length, requests: requestIds.length };
  });

  return ExpertsService.of({
    experts: () => Array.from(experts.values()),
    expert: (id) => experts.get(id),
    putExpert,
    removeExpert: Effect.fn("ExpertsService.removeExpert")(function* (id: string) {
      yield* sql`DELETE FROM logicpacks_experts WHERE id = ${id}`.pipe(
        Effect.mapError(storage("removing an expert")),
      );
      return experts.delete(id);
    }),
    requests: () => Array.from(requests.values()).toSorted((a, b) => b.createdAtMs - a.createdAtMs),
    request: (id) => requests.get(id),
    putRequest: Effect.fn("ExpertsService.putRequest")(function* (request: AssistanceRequest) {
      yield* sql`
        INSERT INTO logicpacks_expert_requests (id, data) VALUES (${request.id}, ${JSON.stringify(request)})
        ON CONFLICT (id) DO UPDATE SET data = excluded.data
      `.pipe(Effect.mapError(storage("saving a request")));
      requests.set(request.id, request);
    }),
    grants: () => Array.from(grants.values()),
    putGrant: Effect.fn("ExpertsService.putGrant")(function* (grant: ProviderGrant) {
      yield* sql`
        INSERT INTO logicpacks_provider_grants (id, data) VALUES (${grant.id}, ${JSON.stringify(grant)})
        ON CONFLICT (id) DO UPDATE SET data = excluded.data
      `.pipe(Effect.mapError(storage("saving a grant")));
      grants.set(grant.id, grant);
    }),
    allows: (granteeUserId, instanceId, projectId) =>
      grantAllows(grants.values(), { granteeUserId, instanceId, projectId }),
    grantedInstanceIds: (granteeUserId) => grantedInstanceIds(grants.values(), granteeUserId),
    forgetUser: Effect.fn("ExpertsService.forgetUser")(function* (
      userId: string,
      options?: { readonly dryRun?: boolean },
    ) {
      return yield* forget(
        (grant) => grant.granteeUserId === userId || grant.ownerUserId === userId,
        (request) => request.requesterUserId === userId || request.expertUserId === userId,
        options?.dryRun === true,
      );
    }),
    forgetProject: Effect.fn("ExpertsService.forgetProject")(function* (
      projectId: string,
      options?: { readonly dryRun?: boolean },
    ) {
      return yield* forget(
        (grant) => grant.projectId === projectId,
        (request) => request.projectId === projectId,
        options?.dryRun === true,
      );
    }),
  });
});

export const layer = Layer.effect(ExpertsService, make);
