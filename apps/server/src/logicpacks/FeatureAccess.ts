// @effect-diagnostics globalDate:off -- grants are checked against wall time in synchronous reads.
// @effect-diagnostics effectFnOpportunity:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off -- rows hold the plain JSON of the featureCodes.ts shapes.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import { HttpServerRequest } from "effect/http";

import { STAFF_EMAILS } from "./accessConfig.ts";
import {
  GRANT_PUBLIC_KEY_SPKI,
  privateKeyFrom,
  publicKeyFrom,
  signGrant,
  verifyGrant,
  type FeatureGrant,
} from "./featureGrant.ts";
import {
  ACCESS_CODE_COOKIE,
  expandFeatures,
  GATED_FEATURES,
  generateCode,
  hashCode,
  isGatedFeature,
  makeRateLimiter,
  normalizeCode,
  redeem,
  REDEEM_MESSAGES,
  type AccessCode,
  type GatedFeature,
} from "./featureCodes.ts";

export class FeatureLockedError extends Schema.TaggedError<FeatureLockedError>()(
  "FeatureLockedError",
  {
    feature: Schema.String,
    message: Schema.String,
  },
) {}

export class FeatureAccessError extends Schema.TaggedError<FeatureAccessError>()(
  "FeatureAccessError",
  {
    reason: Schema.Literals([
      "invalid",
      "unknown",
      "revoked",
      "expired",
      "used_up",
      "rate_limited",
      "not_found",
      "storage",
      "unavailable",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const storage = (operation: string) => (cause: unknown) =>
  new FeatureAccessError({
    reason: "storage",
    message: `Feature access storage failed during ${operation}.`,
    cause,
  });

export interface StaffEntry {
  readonly email: string;
  readonly addedBy: string;
  readonly addedAtMs: number;
}

interface UserFeatures {
  readonly userId: string;
  readonly features: ReadonlyArray<GatedFeature>;
  readonly sources: ReadonlyArray<{ readonly codeId: string; readonly atMs: number }>;
}

/** Who is asking: the host operator (every feature) or a member with an email. */
export type FeatureSubject =
  | { readonly kind: "operator" }
  | { readonly kind: "member"; readonly userId: string; readonly email: string | null };

/**
 * Who has which gated feature. The host operator and staff have all of them; everyone else
 * has what their redeemed access codes unlocked. Reads are synchronous (in-memory maps,
 * written through to SQLite) so stream filters and fences can ask per item.
 */
export class FeatureAccess extends Context.Service<
  FeatureAccess,
  {
    readonly featuresOf: (subject: FeatureSubject) => ReadonlySet<GatedFeature>;
    /** This server is the LogicPacks cloud (app.logicpacks.io): codes live and are counted here. */
    readonly isCloudHost: boolean;
    /** A laptop host: this install's id, sent with codes so grants are bound to it. */
    readonly deviceId: () => Effect.Effect<string, FeatureAccessError>;
    /** A laptop host: the grant its owner redeemed (verified), or null. */
    readonly hostGrant: () => FeatureGrant | null;
    /** A laptop host: verifies and stores a grant from the cloud. */
    readonly setHostGrant: (
      token: string,
      nowMs: number,
    ) => Effect.Effect<FeatureGrant, FeatureAccessError>;
    readonly clearHostGrant: () => Effect.Effect<void, FeatureAccessError>;
    /** The stored grant token, for re-checking it with the cloud. */
    readonly hostGrantToken: () => string | null;
    /** The cloud: redeems a code for a laptop and signs a grant for it. */
    readonly issueGrant: (input: {
      readonly code: string;
      readonly deviceId: string;
      readonly rateKey: string;
      readonly nowMs: number;
    }) => Effect.Effect<string, FeatureAccessError>;
    /**
     * The cloud: a laptop that holds a grant signs in here as a member (cloud sync); its
     * grant's features are recorded on that account. False when the grant is not good.
     */
    readonly adoptGrant: (
      userId: string,
      token: string,
      nowMs: number,
    ) => Effect.Effect<boolean, FeatureAccessError>;
    /** The cloud: whether a grant it signed is still good (code not revoked or expired). */
    readonly grantStillValid: (token: string, nowMs: number) => boolean;
    readonly has: (subject: FeatureSubject, feature: GatedFeature) => boolean;
    readonly isStaff: (subject: FeatureSubject) => boolean;
    readonly isStaffEmail: (email: string) => boolean;
    readonly staff: () => ReadonlyArray<StaffEntry>;
    readonly putStaff: (entry: StaffEntry) => Effect.Effect<void, FeatureAccessError>;
    readonly removeStaff: (email: string) => Effect.Effect<boolean, FeatureAccessError>;
    readonly codes: () => ReadonlyArray<AccessCode>;
    /** Returns the plain code once; only its hash is stored. */
    readonly createCode: (input: {
      readonly features: ReadonlyArray<GatedFeature>;
      readonly maxUses: number | null;
      readonly expiresAtMs: number | null;
      readonly note: string;
      readonly createdBy: string;
      readonly nowMs: number;
    }) => Effect.Effect<{ readonly code: string; readonly record: AccessCode }, FeatureAccessError>;
    readonly revokeCode: (
      id: string,
      nowMs: number,
    ) => Effect.Effect<AccessCode, FeatureAccessError>;
    /** Rate limited per `rateKey` (account and address). */
    readonly redeem: (input: {
      readonly userId: string;
      readonly code: string;
      readonly rateKey: string;
      readonly nowMs: number;
    }) => Effect.Effect<ReadonlyArray<GatedFeature>, FeatureAccessError>;
  }
>()("logicpacks/logicpacks/FeatureAccess") {}

const envList = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

const TABLES = {
  codes: "logicpacks_access_codes",
  users: "logicpacks_user_features",
  staff: "logicpacks_staff",
  host: "logicpacks_host_grant",
} as const;

interface HostRow {
  readonly deviceId: string;
  readonly token: string | null;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of Object.values(TABLES)) {
    yield* sql
      .unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
      .pipe(Effect.mapError(storage("schema setup")));
  }
  const load = <A>(table: keyof typeof TABLES) =>
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
              // Skipped rather than failing the server.
            }
          }
          return map;
        }),
        Effect.mapError(storage(`loading ${table}`)),
      );
  const codes = yield* load<AccessCode>("codes");
  const users = yield* load<UserFeatures>("users");
  const staff = yield* load<StaffEntry>("staff");
  const hostRows = yield* load<HostRow>("host");
  const isCloudHost = /^(1|true|yes|on)$/i.test((process.env.LOGICPACKS_CLOUD_HOST ?? "").trim());
  const publicKey = publicKeyFrom(
    (process.env.LOGICPACKS_GRANT_PUBLIC_KEY ?? "").trim() || GRANT_PUBLIC_KEY_SPKI,
  );
  const signingKey = (() => {
    const inline = (process.env.LOGICPACKS_GRANT_PRIVATE_KEY ?? "").trim();
    const file = (process.env.LOGICPACKS_GRANT_PRIVATE_KEY_FILE ?? "").trim();
    try {
      if (inline.length > 0) return privateKeyFrom(inline);
      if (file.length > 0) return privateKeyFrom(NodeFs.readFileSync(file, "utf8"));
    } catch {
      // No signing key: this host cannot issue grants.
    }
    return null;
  })();
  // The grant is re-verified at load: a tampered or expired row unlocks nothing.
  let host: HostRow | null = hostRows.get("host") ?? null;
  const verifiedGrant = (nowMs: number): FeatureGrant | null => {
    if (host?.token == null) return null;
    const check = verifyGrant(host.token, publicKey, { deviceId: host.deviceId, nowMs });
    return check.ok ? check.grant : null;
  };
  const hostFeatureEnv = () =>
    envList("LOGICPACKS_HOST_FEATURES").filter((f): f is GatedFeature =>
      (GATED_FEATURES as ReadonlyArray<string>).includes(f),
    );
  const put = <A>(table: keyof typeof TABLES, map: Map<string, A>, id: string, value: A) =>
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
  const limiter = makeRateLimiter(10, 10 * 60_000);

  const isStaffEmail = (email: string) => {
    const wanted = email.trim().toLowerCase();
    return (
      STAFF_EMAILS.some((entry) => entry.toLowerCase() === wanted) ||
      envList("LOGICPACKS_STAFF_EMAILS").includes(wanted) ||
      staff.has(wanted)
    );
  };
  // The cloud's owner runs LogicPacks: staff there. A laptop's owner is a customer.
  const isStaff = (subject: FeatureSubject) =>
    subject.kind === "operator"
      ? isCloudHost
      : subject.email !== null && isStaffEmail(subject.email);
  const ALL: ReadonlySet<GatedFeature> = new Set(GATED_FEATURES);
  const featuresOf = (subject: FeatureSubject): ReadonlySet<GatedFeature> => {
    if (isStaff(subject)) return ALL;
    const userId = subject.kind === "member" ? subject.userId : "";
    const out = new Set<GatedFeature>((users.get(userId)?.features ?? []).filter(isGatedFeature));
    if (subject.kind === "member") {
      // Host-wide default for every member (self-hosted teams, test harnesses).
      for (const feature of envList("LOGICPACKS_MEMBER_FEATURES")) {
        if ((GATED_FEATURES as ReadonlyArray<string>).includes(feature))
          out.add(feature as GatedFeature);
      }
    }
    if (!isCloudHost) {
      // A laptop host's code covers its owner and the teammates working on it.
      for (const feature of verifiedGrant(Date.now())?.features ?? []) out.add(feature);
      for (const feature of hostFeatureEnv()) out.add(feature);
    }
    // Host-level grants for tests and small teams: LOGICPACKS_FEATURES_<FEATURE>=email,email.
    if (subject.kind === "member" && subject.email !== null) {
      for (const feature of GATED_FEATURES) {
        if (
          envList(`LOGICPACKS_FEATURES_${feature.toUpperCase()}`).includes(
            subject.email.toLowerCase(),
          )
        ) {
          out.add(feature);
        }
      }
    }
    return expandFeatures(out);
  };
  const putHost = (row: HostRow) =>
    put("host", hostRows, "host", row).pipe(Effect.tap(() => Effect.sync(() => (host = row))));
  const deviceId = () =>
    host !== null
      ? Effect.succeed(host.deviceId)
      : putHost({ deviceId: `dev-${NodeCrypto.randomUUID()}`, token: null }).pipe(
          Effect.map(() => host!.deviceId),
        );

  return FeatureAccess.of({
    featuresOf,
    has: (subject, feature) => featuresOf(subject).has(feature),
    isCloudHost,
    deviceId,
    hostGrant: () => verifiedGrant(Date.now()),
    hostGrantToken: () => host?.token ?? null,
    setHostGrant: Effect.fn("FeatureAccess.setHostGrant")(function* (token, nowMs) {
      const id = yield* deviceId();
      const check = verifyGrant(token, publicKey, { deviceId: id, nowMs });
      if (!check.ok) {
        return yield* new FeatureAccessError({
          reason: "invalid",
          message: "The cloud's answer could not be verified.",
        });
      }
      yield* putHost({ deviceId: id, token });
      return check.grant;
    }),
    clearHostGrant: () =>
      host === null ? Effect.void : putHost({ deviceId: host.deviceId, token: null }),
    issueGrant: Effect.fn("FeatureAccess.issueGrant")(function* (input) {
      if (!isCloudHost || signingKey === null) {
        return yield* new FeatureAccessError({
          reason: "unavailable",
          message: "This server does not issue access.",
        });
      }
      if (!/^dev-[0-9a-f-]{36}$/.test(input.deviceId)) {
        return yield* new FeatureAccessError({ reason: "invalid", message: "Unknown device." });
      }
      if (!limiter(input.rateKey, input.nowMs)) {
        return yield* new FeatureAccessError({
          reason: "rate_limited",
          message: REDEEM_MESSAGES.rate_limited,
        });
      }
      const normal = normalizeCode(input.code);
      if (normal === null)
        return yield* new FeatureAccessError({
          reason: "invalid",
          message: REDEEM_MESSAGES.invalid,
        });
      const result = redeem(codes.get(hashCode(normal)), `device:${input.deviceId}`, input.nowMs);
      if (!result.ok) {
        return yield* new FeatureAccessError({
          reason: result.reason,
          message: REDEEM_MESSAGES[result.reason],
        });
      }
      if (result.fresh) yield* put("codes", codes, result.code.hash, result.code);
      return signGrant(
        {
          v: 1,
          deviceId: input.deviceId,
          features: Array.from(expandFeatures(result.features)),
          codeId: result.code.id,
          issuedAtMs: input.nowMs,
          expiresAtMs: result.code.expiresAtMs,
        },
        signingKey,
      );
    }),
    adoptGrant: Effect.fn("FeatureAccess.adoptGrant")(function* (userId, token, nowMs) {
      if (!isCloudHost || signingKey === null) return false;
      const check = verifyGrant(token, NodeCrypto.createPublicKey(signingKey), {
        deviceId: null,
        nowMs,
      });
      if (!check.ok) return false;
      const code = Array.from(codes.values()).find((entry) => entry.id === check.grant.codeId);
      if (code === undefined || code.revokedAtMs !== null) return false;
      const current = users.get(userId);
      const have = new Set(current?.features ?? []);
      if (check.grant.features.every((feature) => have.has(feature))) return true;
      yield* put("users", users, userId, {
        userId,
        features: Array.from(new Set([...have, ...check.grant.features])),
        sources: [...(current?.sources ?? []), { codeId: code.id, atMs: nowMs }],
      });
      return true;
    }),
    grantStillValid: (token, nowMs) => {
      if (signingKey === null) return true;
      const check = verifyGrant(token, NodeCrypto.createPublicKey(signingKey), {
        deviceId: null,
        nowMs,
      });
      if (!check.ok) return false;
      const code = Array.from(codes.values()).find((entry) => entry.id === check.grant.codeId);
      return (
        code !== undefined &&
        code.revokedAtMs === null &&
        (code.expiresAtMs === null || nowMs <= code.expiresAtMs)
      );
    },
    isStaff,
    isStaffEmail,
    staff: () => Array.from(staff.values()),
    putStaff: (entry) =>
      put("staff", staff, entry.email.toLowerCase(), {
        ...entry,
        email: entry.email.toLowerCase(),
      }),
    removeStaff: (email) =>
      sql.unsafe(`DELETE FROM ${TABLES.staff} WHERE id = ?`, [email.toLowerCase()]).pipe(
        Effect.mapError(storage("removing staff")),
        Effect.map(() => staff.delete(email.toLowerCase())),
      ),
    codes: () => Array.from(codes.values()).toSorted((a, b) => b.createdAtMs - a.createdAtMs),
    createCode: Effect.fn("FeatureAccess.createCode")(function* (input) {
      const features = Array.from(new Set(input.features)).filter((f) =>
        (GATED_FEATURES as ReadonlyArray<string>).includes(f),
      );
      if (features.length === 0) {
        return yield* new FeatureAccessError({
          reason: "invalid",
          message: "Pick at least one feature.",
        });
      }
      let code = generateCode();
      while (codes.has(hashCode(code))) code = generateCode();
      const record: AccessCode = {
        id: `code-${NodeCrypto.randomUUID().slice(0, 8)}`,
        hash: hashCode(code),
        hint: code.slice(-4),
        features,
        maxUses: input.maxUses === null ? null : Math.max(1, Math.floor(input.maxUses)),
        uses: 0,
        expiresAtMs: input.expiresAtMs,
        note: input.note.trim().slice(0, 200),
        createdBy: input.createdBy,
        createdAtMs: input.nowMs,
        revokedAtMs: null,
        redeemedBy: [],
      };
      yield* put("codes", codes, record.hash, record);
      return { code, record };
    }),
    revokeCode: Effect.fn("FeatureAccess.revokeCode")(function* (id, nowMs) {
      const found = Array.from(codes.values()).find((code) => code.id === id);
      if (found === undefined)
        return yield* new FeatureAccessError({ reason: "not_found", message: "No such code." });
      const revoked = { ...found, revokedAtMs: found.revokedAtMs ?? nowMs };
      yield* put("codes", codes, revoked.hash, revoked);
      return revoked;
    }),
    redeem: Effect.fn("FeatureAccess.redeem")(function* (input) {
      if (!limiter(input.rateKey, input.nowMs)) {
        return yield* new FeatureAccessError({
          reason: "rate_limited",
          message: REDEEM_MESSAGES.rate_limited,
        });
      }
      const normal = normalizeCode(input.code);
      if (normal === null)
        return yield* new FeatureAccessError({
          reason: "invalid",
          message: REDEEM_MESSAGES.invalid,
        });
      const result = redeem(codes.get(hashCode(normal)), input.userId, input.nowMs);
      if (!result.ok) {
        return yield* new FeatureAccessError({
          reason: result.reason,
          message: REDEEM_MESSAGES[result.reason],
        });
      }
      if (result.fresh) yield* put("codes", codes, result.code.hash, result.code);
      const current = users.get(input.userId);
      const next: UserFeatures = {
        userId: input.userId,
        features: Array.from(new Set([...(current?.features ?? []), ...result.features])),
        sources: [...(current?.sources ?? []), { codeId: result.code.id, atMs: input.nowMs }],
      };
      yield* put("users", users, input.userId, next);
      return result.features;
    }),
  });
});

export const layer = Layer.effect(FeatureAccess, make);

const clientKey = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  String(
    request.headers["cf-connecting-ip"] ??
      request.headers["x-forwarded-for"] ??
      request.remoteAddress ??
      "local",
  )
    .split(",")[0]!
    .trim(),
);

/**
 * Applies a code typed on the sign-in pages (kept in a short-lived cookie) to the account that
 * just signed in. Every sign-in path calls this through issueMemberSession; failures are
 * ignored so sign-in always works without a code.
 */
export const redeemSignInCode = (userId: string) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(FeatureAccess);
    if (service._tag === "None") return;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = request.cookies[ACCESS_CODE_COOKIE];
    if (!raw) return;
    yield* service.value.redeem({
      userId,
      code: decodeURIComponent(raw),
      rateKey: `ip:${yield* clientKey}`,
      nowMs: yield* Clock.currentTimeMillis,
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logInfo("Access code at sign-in not applied", { cause })),
  );
