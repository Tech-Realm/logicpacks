// @effect-diagnostics effectFnOpportunity:off
// @effect-diagnostics preferSchemaOverJson:off -- rows hold the plain JSON of the externalTeam.ts shapes.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ACCESS_OFFER, type Charge, type Offer } from "./externalTeam.ts";
import { SEED_TALENT, type TalentProfile } from "./externalTalentSeed.ts";

export class ExternalTeamError extends Schema.TaggedError<ExternalTeamError>()(
  "ExternalTeamError",
  {
    reason: Schema.Literals(["not_found", "invalid", "forbidden", "storage"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const storage = (operation: string) => (cause: unknown) =>
  new ExternalTeamError({
    reason: "storage",
    message: `External team storage failed during ${operation}.`,
    cause,
  });

type Table = "talent" | "offers" | "charges" | "prefs";
const TABLES: Record<Table, string> = {
  talent: "logicpacks_external_talent",
  offers: "logicpacks_external_offers",
  charges: "logicpacks_external_charges",
  prefs: "logicpacks_external_prefs",
};

/**
 * Talent, offers, charges and per-account region choices. Rows hold JSON so the shapes
 * in `externalTeam.ts` stay the one definition; one process owns the database, so the
 * in-memory maps are authoritative and the RPC fence can ask synchronously.
 */
export class ExternalTeamService extends Context.Service<
  ExternalTeamService,
  {
    readonly talents: () => ReadonlyArray<TalentProfile>;
    readonly talent: (id: string) => TalentProfile | undefined;
    readonly putTalent: (talent: TalentProfile) => Effect.Effect<void, ExternalTeamError>;
    readonly offers: () => ReadonlyArray<Offer>;
    readonly offer: (id: string) => Offer | undefined;
    readonly putOffer: (offer: Offer) => Effect.Effect<void, ExternalTeamError>;
    readonly charges: () => ReadonlyArray<Charge>;
    readonly chargeFor: (offerId: string) => Charge | undefined;
    readonly putCharge: (charge: Charge) => Effect.Effect<void, ExternalTeamError>;
    readonly accountRegion: (owner: string) => string | null;
    readonly setAccountRegion: (
      owner: string,
      region: string | null,
    ) => Effect.Effect<void, ExternalTeamError>;
    /**
     * The open offer that gives this person access to this project as an external member, by
     * account or (before the account is linked) by the email they were assigned under.
     * Synchronous so the RPC fence can ask per request.
     */
    readonly externalAccess: (
      user: { readonly userId: string; readonly email: string | null },
      projectId: string,
    ) => Offer | undefined;
    readonly isExternalAnywhere: (user: {
      readonly userId: string;
      readonly email: string | null;
    }) => boolean;
    /**
     * Account deletion: the offers this user asked for (and their charges), their job
     * applications and region choice. Offers that assign them to someone else's project stay
     * (returned in `assignedOfferIds`) for staff to end. With `dryRun` only counts.
     */
    readonly forgetUser: (
      userId: string,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<ExternalForgetResult, ExternalTeamError>;
    /** A deleted project's offers and their charges. */
    readonly forgetProject: (
      projectId: string,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<ExternalForgetResult, ExternalTeamError>;
  }
>()("logicpacks/logicpacks/ExternalTeamService") {}

export interface ExternalForgetResult {
  readonly offers: number;
  readonly charges: number;
  readonly applications: number;
  readonly prefs: number;
  readonly assignedOfferIds: ReadonlyArray<string>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of Object.values(TABLES)) {
    yield* sql
      .unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
      .pipe(Effect.mapError(storage("schema setup")));
  }
  const load = <A>(table: Table) =>
    sql
      .unsafe<{ readonly id: string; readonly data: string }>(
        `SELECT id, data FROM ${TABLES[table]}`,
      )
      .pipe(
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
  const talent = yield* load<TalentProfile>("talent");
  const offers = yield* load<Offer>("offers");
  const charges = yield* load<Charge>("charges");
  const prefs = yield* load<{ readonly region: string }>("prefs");

  const put = <A>(table: Table, map: Map<string, A>, id: string, value: A) =>
    sql
      .unsafe(
        `INSERT INTO ${TABLES[table]} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
        [id, JSON.stringify(value)],
      )
      .pipe(
        Effect.mapError(storage(`saving ${table}`)),
        Effect.tap(() => Effect.sync(() => map.set(id, value))),
        Effect.asVoid,
      );
  const remove = <A>(table: Table, map: Map<string, A>, id: string) =>
    sql.unsafe(`DELETE FROM ${TABLES[table]} WHERE id = ?`, [id]).pipe(
      Effect.mapError(storage(`removing from ${table}`)),
      Effect.map(() => map.delete(id)),
    );

  // The seed goes in once (marker row), so staff edits and removals stick.
  if (!prefs.has("__talent_seeded")) {
    for (const profile of SEED_TALENT) {
      if (!talent.has(profile.id)) yield* put("talent", talent, profile.id, profile);
    }
    yield* put("prefs", prefs, "__talent_seeded", { region: "" });
  }

  const matchesUser = (
    offer: Offer,
    user: { readonly userId: string; readonly email: string | null },
  ) =>
    offer.assignment !== null &&
    (offer.assignment.userId === user.userId ||
      (offer.assignment.userId === null &&
        user.email !== null &&
        offer.assignment.email.toLowerCase() === user.email.toLowerCase()));

  const forget = (
    offerMatches: (offer: Offer) => boolean,
    userId: string | null,
    dryRun: boolean,
  ): Effect.Effect<ExternalForgetResult, ExternalTeamError> =>
    Effect.gen(function* () {
      const doomed = Array.from(offers.values()).filter(offerMatches);
      const doomedIds = new Set(doomed.map((offer) => offer.id));
      const doomedCharges = Array.from(charges.values()).filter((charge) =>
        doomedIds.has(charge.offerId),
      );
      const applied =
        userId === null
          ? []
          : Array.from(offers.values()).filter(
              (offer) =>
                !doomedIds.has(offer.id) &&
                offer.applications.some((entry) => entry.userId === userId),
            );
      const applications = applied.reduce(
        (sum, offer) => sum + offer.applications.filter((entry) => entry.userId === userId).length,
        0,
      );
      const assignedOfferIds =
        userId === null
          ? []
          : Array.from(offers.values())
              .filter((offer) => !doomedIds.has(offer.id) && offer.assignment?.userId === userId)
              .map((offer) => offer.id);
      const hasPrefs = userId !== null && prefs.has(userId);
      if (!dryRun) {
        for (const charge of doomedCharges) yield* remove("charges", charges, charge.id);
        for (const offer of doomed) yield* remove("offers", offers, offer.id);
        for (const offer of applied) {
          yield* put("offers", offers, offer.id, {
            ...offer,
            applications: offer.applications.filter((entry) => entry.userId !== userId),
          });
        }
        if (hasPrefs) yield* remove("prefs", prefs, userId);
      }
      return {
        offers: doomed.length,
        charges: doomedCharges.length,
        applications,
        prefs: hasPrefs ? 1 : 0,
        assignedOfferIds,
      };
    });

  return ExternalTeamService.of({
    talents: () => Array.from(talent.values()),
    talent: (id) => talent.get(id),
    putTalent: (profile) => put("talent", talent, profile.id, profile),
    offers: () => Array.from(offers.values()).toSorted((a, b) => b.createdAtMs - a.createdAtMs),
    offer: (id) => offers.get(id),
    putOffer: (offer) => put("offers", offers, offer.id, offer),
    charges: () => Array.from(charges.values()),
    chargeFor: (offerId) =>
      Array.from(charges.values()).find((charge) => charge.offerId === offerId),
    putCharge: (charge) => put("charges", charges, charge.id, charge),
    accountRegion: (owner) => prefs.get(owner)?.region || null,
    setAccountRegion: (owner, region) =>
      region === null
        ? remove("prefs", prefs, owner).pipe(Effect.asVoid)
        : put("prefs", prefs, owner, { region }),
    externalAccess: (user, projectId) => {
      for (const offer of offers.values()) {
        if (
          offer.projectId === projectId &&
          ACCESS_OFFER.has(offer.status) &&
          matchesUser(offer, user)
        )
          return offer;
      }
      return undefined;
    },
    isExternalAnywhere: (user) => {
      for (const offer of offers.values()) {
        if (ACCESS_OFFER.has(offer.status) && matchesUser(offer, user)) return true;
      }
      return false;
    },
    forgetUser: (userId, options) =>
      forget((offer) => offer.customerUserId === userId, userId, options?.dryRun === true),
    forgetProject: (projectId, options) =>
      forget((offer) => offer.projectId === projectId, null, options?.dryRun === true),
  });
});

export const layer = Layer.effect(ExternalTeamService, make);
