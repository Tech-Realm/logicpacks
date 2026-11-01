// @effect-diagnostics nodeBuiltinImport:off -- these run inside the member runner too (serialised), so they use node builtins directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Member provider logins at rest, encrypted.
 *
 * Every credential file a member's CLI keeps (Claude's .credentials.json, Codex's auth.json,
 * OpenCode's auth.json, Gemini's oauth_creds.json) and every member provider token the server
 * keeps in its secret store is stored as AES-256-GCM ciphertext under a per-member key:
 * HKDF-SHA256(master key, member digest). The master key is LOGICPACKS_LOGIN_KEY (systemd
 * env, copied to a root-only tmpfs file for the runner) or `<baseDir>/secrets/login.key`.
 *
 * A credential file is plaintext only while a CLI that needs it is running: the root-run
 * member runner unseals it to its usual path (0600, owned by the member) before the CLI starts,
 * and when the last of that member's processes for that CLI exits it seals the current file
 * (so a refreshed token is kept) and shreds the plaintext.
 *
 * Threat model: protects logins in disk images, backups and snapshots that do not also hold
 * the key, and against reads that are not root. Root on the running host can read the key and
 * so every login; this is not protection from the host's operator.
 *
 * The functions marked "serialised" are copied into the runner with Function#toString: they
 * must not reference anything outside their own bodies.
 */

/** serialised. Credential files a CLI keeps in its provider home, relative to that home. */
export function vaultCredentialFiles(kind: string): ReadonlyArray<string> {
  switch (kind) {
    case "claude":
      return [".credentials.json"];
    case "codex":
      return ["auth.json"];
    case "opencode":
      return ["opencode/auth.json"];
    case "gemini":
      return [".gemini/oauth_creds.json", ".gemini/google_accounts.json"];
    default:
      return [];
  }
}

/** serialised. The per-member key: HKDF-SHA256 over the master key, bound to the member. */
export function vaultMemberKey(master: Uint8Array, digest: string): Buffer {
  const crypto = process.getBuiltinModule("node:crypto");
  if (master.length < 32) throw new Error("login key must be at least 32 bytes");
  return Buffer.from(
    crypto.hkdfSync("sha256", master, "logicpacks/login-vault/v1", `member:${digest}`, 32),
  );
}

/** serialised. `LPV1 | iv(12) | tag(16) | ciphertext`; the AAD binds it to member and path. */
export function vaultSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const crypto = process.getBuiltinModule("node:crypto");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("LPV1"), iv, cipher.getAuthTag(), body]);
}

/** serialised. */
export function vaultIsSealed(bytes: Uint8Array): boolean {
  return bytes.length >= 32 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "LPV1";
}

/** serialised. Throws when the key, the AAD or the bytes do not match. */
export function vaultOpen(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  const crypto = process.getBuiltinModule("node:crypto");
  const bytes = Buffer.from(sealed);
  if (bytes.length < 32 || bytes.subarray(0, 4).toString("latin1") !== "LPV1") {
    throw new Error("not a sealed login");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(4, 16));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
}

/**
 * serialised. Overwrites a file with random bytes, syncs and unlinks it. On copy-on-write
 * filesystems (ZFS, btrfs) old blocks can survive in snapshots: this is best effort.
 */
export function vaultShred(path: string): void {
  const fs = process.getBuiltinModule("node:fs");
  const crypto = process.getBuiltinModule("node:crypto");
  let size = 0;
  try {
    size = fs.statSync(path).size;
  } catch {
    return;
  }
  try {
    const fd = fs.openSync(path, "r+");
    try {
      fs.writeSync(fd, crypto.randomBytes(Math.max(size, 1)), 0, Math.max(size, 1), 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // unwritable: still unlink below
  }
  try {
    fs.unlinkSync(path);
  } catch {
    // gone
  }
}

/** serialised. Writes `bytes` to `path` atomically with `mode`. */
export function vaultWriteAtomic(path: string, bytes: Uint8Array, mode: number): void {
  const fs = process.getBuiltinModule("node:fs");
  const nodePath = process.getBuiltinModule("node:path");
  const crypto = process.getBuiltinModule("node:crypto");
  fs.mkdirSync(nodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, path);
}

/**
 * serialised. Seals every plaintext credential file of one CLI in a member's provider home and
 * shreds the plaintext. A plaintext file found here is the newest (a refreshed token, or a
 * login from before encryption: the migration), so it always wins over the old ciphertext.
 */
export function vaultSealHome(key: Uint8Array, digest: string, kind: string, home: string): number {
  const fs = process.getBuiltinModule("node:fs");
  const nodePath = process.getBuiltinModule("node:path");
  let sealed = 0;
  // eslint-disable-next-line no-undef -- serialised next to vaultCredentialFiles.
  for (const relative of vaultCredentialFiles(kind)) {
    const plain = nodePath.join(home, relative);
    let bytes;
    try {
      if (!fs.lstatSync(plain).isFile()) continue;
      bytes = fs.readFileSync(plain);
    } catch {
      continue;
    }
    // eslint-disable-next-line no-undef -- serialised.
    vaultWriteAtomic(
      `${plain}.lpvault`,
      vaultSeal(key, bytes, `${digest}/${kind}/${relative}`),
      0o600,
    );
    // eslint-disable-next-line no-undef -- serialised.
    vaultShred(plain);
    sealed += 1;
  }
  return sealed;
}

/**
 * serialised. Puts each sealed credential back at its usual path (0600, owned by the member)
 * for a CLI about to run. A plaintext file already there (another live process, or a login
 * waiting to be sealed) is left as it is.
 */
export function vaultUnsealHome(
  key: Uint8Array,
  digest: string,
  kind: string,
  home: string,
  owner: { readonly uid: number; readonly gid: number } | null,
): number {
  const fs = process.getBuiltinModule("node:fs");
  const nodePath = process.getBuiltinModule("node:path");
  let opened = 0;
  // eslint-disable-next-line no-undef -- serialised.
  for (const relative of vaultCredentialFiles(kind)) {
    const plain = nodePath.join(home, relative);
    if (fs.existsSync(plain)) {
      // Already open (another live process, or a plaintext login not sealed yet): make sure it
      // is the member's alone.
      try {
        fs.chmodSync(plain, 0o600);
        if (owner !== null) fs.chownSync(plain, owner.uid, owner.gid);
      } catch {
        // not ours to fix
      }
      continue;
    }
    let sealed;
    try {
      sealed = fs.readFileSync(`${plain}.lpvault`);
    } catch {
      continue;
    }
    // eslint-disable-next-line no-undef -- serialised.
    const bytes = vaultOpen(key, sealed, `${digest}/${kind}/${relative}`);
    // eslint-disable-next-line no-undef -- serialised.
    vaultWriteAtomic(plain, bytes, 0o600);
    if (owner !== null) {
      fs.chownSync(plain, owner.uid, owner.gid);
      fs.chownSync(nodePath.dirname(plain), owner.uid, owner.gid);
    }
    opened += 1;
  }
  return opened;
}

/** serialised. The master key: a root-only tmpfs copy of LOGICPACKS_LOGIN_KEY, or the key file. */
export function vaultReadMasterKey(candidates: ReadonlyArray<string>): Buffer | null {
  const fs = process.getBuiltinModule("node:fs");
  for (const path of candidates) {
    try {
      const raw = fs.readFileSync(path);
      if (raw.length >= 32) return raw;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * serialised. Leases: one file per running process that uses a member's CLI credentials, in a
 * root-only directory. The last process out seals.
 */
export function vaultAcquire(leaseDir: string, pid: number): void {
  const fs = process.getBuiltinModule("node:fs");
  fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${leaseDir}/${pid}`, "");
}

/** serialised. Drops this process's lease; true when no other live process holds one. */
export function vaultRelease(leaseDir: string, pid: number): boolean {
  const fs = process.getBuiltinModule("node:fs");
  try {
    fs.unlinkSync(`${leaseDir}/${pid}`);
  } catch {
    // already gone
  }
  let entries: Array<string> = [];
  try {
    entries = fs.readdirSync(leaseDir);
  } catch {
    return true;
  }
  let others = 0;
  for (const entry of entries) {
    const other = Number(entry);
    if (!Number.isInteger(other) || other <= 0) continue;
    try {
      process.kill(other, 0);
      others += 1;
    } catch {
      try {
        fs.unlinkSync(`${leaseDir}/${entry}`);
      } catch {
        // gone
      }
    }
  }
  return others === 0;
}

/** The runner's names for VAULT_RUNNER_FUNCTIONS, in the same order (not minified). */
export const VAULT_FUNCTION_KEYS = [
  "vaultCredentialFiles",
  "vaultMemberKey",
  "vaultSeal",
  "vaultIsSealed",
  "vaultOpen",
  "vaultShred",
  "vaultWriteAtomic",
  "vaultSealHome",
  "vaultUnsealHome",
  "vaultReadMasterKey",
  "vaultAcquire",
  "vaultRelease",
] as const;

/** Every function the runner needs, in dependency order. */
export const VAULT_RUNNER_FUNCTIONS = [
  vaultCredentialFiles,
  vaultMemberKey,
  vaultSeal,
  vaultIsSealed,
  vaultOpen,
  vaultShred,
  vaultWriteAtomic,
  vaultSealHome,
  vaultUnsealHome,
  vaultReadMasterKey,
  vaultAcquire,
  vaultRelease,
] as const;

// ---------------------------------------------------------------------------------------------
// Server side (not serialised).

/** Where the runner finds LOGICPACKS_LOGIN_KEY: tmpfs, so a key given in the env never hits disk. */
export const RUNTIME_KEY_PATH = "/run/lp-v2/login.key";
export const loginKeyFile = (baseDir: string) => NodePath.join(baseDir, "secrets", "login.key");
/** A member CLI's lease directory (root-only, under the sandbox dir); the runner builds the same path. */
export const vaultLeaseDir = (baseDir: string, digest: string, kind: string) =>
  NodePath.join(baseDir, "sandbox", "leases", digest, kind);
/** Set by Disconnect: a process still running must shred its credential on exit, not seal it. */
export const vaultRevokedMarker = (baseDir: string, digest: string, kind: string) =>
  `${vaultLeaseDir(baseDir, digest, kind)}.revoked`;

interface VaultState {
  readonly baseDir: string;
  readonly master: Buffer;
  /** Paths the runner tries for the master key, in order. */
  readonly keyCandidates: ReadonlyArray<string>;
}

let vault: VaultState | null = null;

/** Whether member logins are encrypted on this server (a master key is configured). */
export const loginVaultState = () => vault;

const decodeKey = (raw: string): Buffer | null => {
  const text = raw.trim();
  if (text.length === 0) return null;
  const hex = /^[0-9a-fA-F]+$/.test(text) ? Buffer.from(text, "hex") : null;
  const bytes = hex ?? Buffer.from(text, "base64");
  return bytes.length >= 32 ? bytes : null;
};

/**
 * Loads the master key (idempotent). LOGICPACKS_LOGIN_KEY wins (hex or base64, >= 32 bytes) and
 * is copied to a root-only tmpfs file for the runner; otherwise `<baseDir>/secrets/login.key`,
 * generated (0600) when `generate` is set and it does not exist yet.
 */
export const configureLoginVault = (
  baseDir: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly generate?: boolean;
    readonly runtimeKeyPath?: string;
  } = {},
): VaultState | null => {
  if (vault !== null && vault.baseDir === baseDir) return vault;
  const env = options.env ?? process.env;
  const runtimeKeyPath = options.runtimeKeyPath ?? RUNTIME_KEY_PATH;
  const fromEnv = decodeKey(env.LOGICPACKS_LOGIN_KEY ?? "");
  if ((env.LOGICPACKS_LOGIN_KEY ?? "").trim().length > 0 && fromEnv === null) {
    throw new Error("LOGICPACKS_LOGIN_KEY must be at least 32 bytes, hex or base64.");
  }
  const file = loginKeyFile(baseDir);
  let master: Buffer | null = null;
  const candidates: Array<string> = [];
  if (fromEnv !== null) {
    master = fromEnv;
    try {
      NodeFS.mkdirSync(NodePath.dirname(runtimeKeyPath), { recursive: true, mode: 0o700 });
      NodeFS.chmodSync(NodePath.dirname(runtimeKeyPath), 0o700);
      vaultWriteAtomic(runtimeKeyPath, fromEnv, 0o600);
      candidates.push(runtimeKeyPath);
    } catch {
      // No tmpfs to hand the key to the runner: it falls back to the key file below.
    }
  } else {
    master = vaultReadMasterKey([file]);
    if (master === null && options.generate === true) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      NodeFS.chmodSync(NodePath.dirname(file), 0o700);
      const generated = process.getBuiltinModule("node:crypto").randomBytes(32);
      vaultWriteAtomic(file, generated, 0o600);
      master = generated;
    }
  }
  if (master === null) return (vault = null);
  candidates.push(file);
  vault = { baseDir, master, keyCandidates: candidates };
  return vault;
};

/** Test hook. */
export const resetLoginVaultForTests = () => {
  vault = null;
};

const vaultKey = (digest: string) => (vault === null ? null : vaultMemberKey(vault.master, digest));

/** `<baseDir>/members/<digest>/.lp/<kind>` -> digest and kind; null for any other home. */
export const vaultHomeOwner = (home: string): { digest: string; kind: string } | null => {
  const match = /[/\\]members[/\\]([0-9a-f]{16})[/\\]\.lp[/\\]([a-z]+)[/\\]?$/.exec(home);
  return match === null ? null : { digest: match[1]!, kind: match[2]! };
};

/**
 * A credential file in a member's provider home as the server reads it (status checks): the
 * plaintext while a CLI holds it, otherwise the decrypted ciphertext.
 */
export const readVaultedFile = (home: string, relative: string): Buffer | null => {
  const plain = NodePath.join(home, relative);
  try {
    return NodeFS.readFileSync(plain);
  } catch {
    // sealed, or absent
  }
  const owner = vaultHomeOwner(home);
  const key = owner === null ? null : vaultKey(owner.digest);
  if (owner === null || key === null) return null;
  try {
    return vaultOpen(
      key,
      NodeFS.readFileSync(`${plain}.lpvault`),
      `${owner.digest}/${owner.kind}/${relative}`,
    );
  } catch {
    return null;
  }
};

/**
 * Seals a member's provider home now unless a CLI is running on it (the last one out seals).
 * Run after a login finishes and at startup, which is also the migration of plaintext logins.
 */
export const sealIdleProviderHome = (home: string): number => {
  const owner = vaultHomeOwner(home);
  if (owner === null || vault === null) return 0;
  const leases = vaultLeaseDir(vault.baseDir, owner.digest, owner.kind);
  // A new login replaces a disconnected one.
  NodeFS.rmSync(vaultRevokedMarker(vault.baseDir, owner.digest, owner.kind), { force: true });
  if (!vaultRelease(leases, -1)) return 0;
  return vaultSealHome(vaultKey(owner.digest)!, owner.digest, owner.kind, home);
};

/** Startup: seals every idle member login still in plaintext (migration from before encryption). */
export const sealAllIdleMemberLogins = (baseDir: string): number => {
  if (vault === null) return 0;
  let sealed = 0;
  const membersDir = NodePath.join(baseDir, "members");
  let digests: Array<string> = [];
  try {
    digests = NodeFS.readdirSync(membersDir).filter((entry) => /^[0-9a-f]{16}$/.test(entry));
  } catch {
    return 0;
  }
  for (const digest of digests) {
    for (const kind of ["claude", "codex", "opencode", "gemini"]) {
      const home = NodePath.join(membersDir, digest, ".lp", kind);
      if (NodeFS.existsSync(home)) sealed += sealIdleProviderHome(home);
    }
  }
  return sealed;
};

/**
 * Disconnect: shreds the credential's ciphertext and any plaintext copy, and tells a CLI still
 * running on it to shred rather than seal when it exits.
 */
export const forgetProviderLogin = (home: string): void => {
  const owner = vaultHomeOwner(home);
  const kind = owner?.kind ?? NodePath.basename(home);
  if (owner !== null && vault !== null) {
    const marker = vaultRevokedMarker(vault.baseDir, owner.digest, owner.kind);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(marker, "");
  }
  for (const relative of vaultCredentialFiles(kind)) {
    const plain = NodePath.join(home, relative);
    vaultShred(plain);
    vaultShred(`${plain}.lpvault`);
  }
};

// Member provider tokens in the server's secret store (`provider-env-<instance>-<VAR>`).

const MEMBER_SECRET = /^provider-env-([A-Za-z0-9_-]+)-[A-Za-z0-9_-]+$/;

/** The member digest a secret belongs to, when it is a member provider instance's secret. */
export const memberSecretDigest = (name: string): string | null => {
  const match = MEMBER_SECRET.exec(name);
  if (match === null) return null;
  const instanceId = Buffer.from(match[1]!, "base64url").toString("utf8");
  const member = /^(?:claude|codex|opencode|gemini)-lp-([0-9a-f]{16})$/.exec(instanceId);
  return member === null ? null : member[1]!;
};

/** What the secret store writes for `name`: sealed for member secrets when a key is set. */
export const sealStoredSecret = (name: string, value: Uint8Array): Uint8Array => {
  const digest = memberSecretDigest(name);
  const key = digest === null ? null : vaultKey(digest);
  return key === null ? value : vaultSeal(key, value, `${digest}/secret/${name}`);
};

/**
 * What the secret store returns for the bytes it read. `migrate` is set when a member secret
 * is still plaintext (written before encryption) and should be written back sealed.
 */
export const openStoredSecret = (
  name: string,
  stored: Uint8Array,
): { readonly value: Uint8Array; readonly migrate: boolean } => {
  const digest = memberSecretDigest(name);
  const key = digest === null ? null : vaultKey(digest);
  if (key === null) return { value: stored, migrate: false };
  if (!vaultIsSealed(stored)) return { value: stored, migrate: true };
  return { value: vaultOpen(key, stored, `${digest}/secret/${name}`), migrate: false };
};

/** Whether removing `name` from the secret store should shred it (member logins). */
export const shredsOnRemove = (name: string) => memberSecretDigest(name) !== null;
