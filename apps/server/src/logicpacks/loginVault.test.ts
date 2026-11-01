// @effect-diagnostics nodeBuiltinImport:off -- the vault is checked against real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  configureLoginVault,
  forgetProviderLogin,
  memberSecretDigest,
  openStoredSecret,
  readVaultedFile,
  resetLoginVaultForTests,
  sealAllIdleMemberLogins,
  sealIdleProviderHome,
  sealStoredSecret,
  vaultAcquire,
  vaultHomeOwner,
  vaultIsSealed,
  vaultLeaseDir,
  vaultMemberKey,
  vaultOpen,
  vaultRelease,
  vaultRevokedMarker,
  vaultSeal,
  vaultSealHome,
  vaultUnsealHome,
} from "./loginVault.ts";

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-vault-")));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const ANA = "aaaaaaaaaaaaaaaa";
const BO = "bbbbbbbbbbbbbbbb";
const master = NodeCrypto.randomBytes(32);
let base = "";
let counter = 0;

/** A fresh host: base dir, key given as LOGICPACKS_LOGIN_KEY (hex), runtime key in a temp dir. */
const freshHost = () => {
  resetLoginVaultForTests();
  counter += 1;
  base = NodePath.join(root, `host-${counter}`);
  NodeFS.mkdirSync(base, { recursive: true });
  return configureLoginVault(base, {
    env: { LOGICPACKS_LOGIN_KEY: master.toString("hex") },
    runtimeKeyPath: NodePath.join(base, "run", "login.key"),
  })!;
};
const providerHome = (digest: string, kind: string) =>
  NodePath.join(base, "members", digest, ".lp", kind);
const writeLogin = (digest: string, kind: string, relative: string, body: string) => {
  const file = NodePath.join(providerHome(digest, kind), relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, body, { mode: 0o600 });
  return file;
};
/** Every regular file under a directory whose contents include `needle`. */
const filesContaining = (dir: string, needle: string): Array<string> => {
  const found: Array<string> = [];
  const walk = (current: string) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const path = NodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && NodeFS.readFileSync(path).includes(needle)) found.push(path);
    }
  };
  walk(dir);
  return found;
};

beforeEach(() => {
  freshHost();
});

describe("encryption", () => {
  it("round-trips with the member's key and its path", () => {
    const key = vaultMemberKey(master, ANA);
    const sealed = vaultSeal(key, Buffer.from("sk-ant-secret"), `${ANA}/claude/.credentials.json`);
    expect(vaultIsSealed(sealed)).toBe(true);
    expect(sealed.includes(Buffer.from("sk-ant-secret"))).toBe(false);
    expect(String(vaultOpen(key, sealed, `${ANA}/claude/.credentials.json`))).toBe("sk-ant-secret");
  });

  it("another member's key, another path or a changed byte cannot open it", () => {
    const key = vaultMemberKey(master, ANA);
    const sealed = vaultSeal(key, Buffer.from("token"), `${ANA}/codex/auth.json`);
    expect(() => vaultOpen(vaultMemberKey(master, BO), sealed, `${ANA}/codex/auth.json`)).toThrow();
    expect(() => vaultOpen(key, sealed, `${BO}/codex/auth.json`)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
    expect(() => vaultOpen(key, tampered, `${ANA}/codex/auth.json`)).toThrow();
    expect(() =>
      vaultOpen(vaultMemberKey(NodeCrypto.randomBytes(32), ANA), sealed, `${ANA}/codex/auth.json`),
    ).toThrow();
  });

  it("per-member keys differ and need a 32-byte master", () => {
    expect(vaultMemberKey(master, ANA).equals(vaultMemberKey(master, BO))).toBe(false);
    expect(() => vaultMemberKey(Buffer.alloc(16), ANA)).toThrow();
  });
});

describe("an agent turn", () => {
  it("leaves no plaintext at rest and keeps a refreshed token", () => {
    const home = providerHome(ANA, "codex");
    writeLogin(ANA, "codex", "auth.json", '{"tokens":{"access":"OLD-TOKEN"}}');
    expect(sealIdleProviderHome(home)).toBe(1);
    expect(NodeFS.existsSync(NodePath.join(home, "auth.json"))).toBe(false);
    expect(filesContaining(base, "OLD-TOKEN")).toEqual([]);

    // The runner: lease, unseal, the CLI refreshes its token, last one out seals.
    const leases = vaultLeaseDir(base, ANA, "codex");
    const key = vaultMemberKey(master, ANA);
    vaultAcquire(leases, process.pid);
    expect(vaultUnsealHome(key, ANA, "codex", home, null)).toBe(1);
    const plain = NodePath.join(home, "auth.json");
    expect(String(NodeFS.readFileSync(plain))).toContain("OLD-TOKEN");
    expect(NodeFS.statSync(plain).mode & 0o777).toBe(0o600);
    NodeFS.writeFileSync(plain, '{"tokens":{"access":"NEW-TOKEN"}}');
    expect(vaultRelease(leases, process.pid)).toBe(true);
    vaultSealHome(key, ANA, "codex", home);

    expect(NodeFS.existsSync(plain)).toBe(false);
    expect(filesContaining(base, "NEW-TOKEN")).toEqual([]);
    expect(filesContaining(base, "OLD-TOKEN")).toEqual([]);
    expect(String(readVaultedFile(home, "auth.json"))).toContain("NEW-TOKEN");
  });

  it("a plaintext login found at start is tightened to 0600 and used as it is", () => {
    const home = providerHome(BO, "codex");
    const plain = writeLogin(BO, "codex", "auth.json", "LOOSE");
    NodeFS.chmodSync(plain, 0o644);
    expect(vaultUnsealHome(vaultMemberKey(master, BO), BO, "codex", home, null)).toBe(0);
    expect(NodeFS.statSync(plain).mode & 0o777).toBe(0o600);
  });

  it("does not seal while another process of the member still uses the login", () => {
    const leases = vaultLeaseDir(base, ANA, "opencode");
    const other = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      vaultAcquire(leases, other.pid!);
      vaultAcquire(leases, process.pid);
      expect(vaultRelease(leases, process.pid)).toBe(false);
    } finally {
      other.kill();
    }
  });

  it("forgets leases of processes that died without releasing", () => {
    const leases = vaultLeaseDir(base, BO, "gemini");
    vaultAcquire(leases, 999_999_9);
    expect(vaultRelease(leases, process.pid)).toBe(true);
  });
});

describe("isolation between members", () => {
  it("a member's ciphertext is 0600 and only their key opens it", () => {
    const home = providerHome(ANA, "opencode");
    writeLogin(ANA, "opencode", "opencode/auth.json", '{"copilot":{"refresh":"ANA-SECRET"}}');
    sealIdleProviderHome(home);
    const sealedPath = NodePath.join(home, "opencode", "auth.json.lpvault");
    expect(NodeFS.statSync(sealedPath).mode & 0o777).toBe(0o600);
    const sealed = NodeFS.readFileSync(sealedPath);
    // Copied into Bo's home it still does not open: the key and the AAD are Ana's.
    const boHome = providerHome(BO, "opencode");
    NodeFS.mkdirSync(NodePath.join(boHome, "opencode"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(boHome, "opencode", "auth.json.lpvault"), sealed);
    expect(readVaultedFile(boHome, NodePath.join("opencode", "auth.json"))).toBeNull();
    expect(() =>
      vaultUnsealHome(vaultMemberKey(master, BO), BO, "opencode", boHome, null),
    ).toThrow();
  });
});

describe("migration", () => {
  it("seals plaintext logins from before encryption at startup", () => {
    writeLogin(ANA, "codex", "auth.json", '{"tokens":{"a":"LEGACY-CODEX"}}');
    writeLogin(BO, "gemini", ".gemini/oauth_creds.json", '{"refresh_token":"LEGACY-GEMINI"}');
    expect(sealAllIdleMemberLogins(base)).toBe(2);
    expect(filesContaining(base, "LEGACY-")).toEqual([]);
    expect(String(readVaultedFile(providerHome(ANA, "codex"), "auth.json"))).toContain(
      "LEGACY-CODEX",
    );
  });

  it("leaves a login alone while its CLI is running", () => {
    writeLogin(ANA, "claude", ".credentials.json", "IN-USE");
    vaultAcquire(vaultLeaseDir(base, ANA, "claude"), process.pid);
    expect(sealAllIdleMemberLogins(base)).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(providerHome(ANA, "claude"), ".credentials.json"))).toBe(
      true,
    );
  });

  it("seals member tokens in the secret store and migrates plaintext ones", () => {
    const name = `provider-env-${Buffer.from(`claude-lp-${ANA}`).toString("base64url")}-${Buffer.from("CLAUDE_CODE_OAUTH_TOKEN").toString("base64url")}`;
    expect(memberSecretDigest(name)).toBe(ANA);
    const stored = sealStoredSecret(name, Buffer.from("sk-ant-oat01-x"));
    expect(vaultIsSealed(stored)).toBe(true);
    expect(Buffer.from(stored).includes(Buffer.from("sk-ant"))).toBe(false);
    expect(String(Buffer.from(openStoredSecret(name, stored).value))).toBe("sk-ant-oat01-x");
    const legacy = openStoredSecret(name, Buffer.from("sk-ant-oat01-x"));
    expect(legacy.migrate).toBe(true);
    expect(String(Buffer.from(legacy.value))).toBe("sk-ant-oat01-x");
    // The host's own secrets are left as they are.
    const hostName = `provider-env-${Buffer.from("claudeAgent").toString("base64url")}-${Buffer.from("X").toString("base64url")}`;
    expect(memberSecretDigest(hostName)).toBeNull();
    expect(sealStoredSecret(hostName, Buffer.from("plain"))).toEqual(Buffer.from("plain"));
  });
});

describe("sign out", () => {
  it("shreds the ciphertext and any plaintext copy, and a running CLI must not re-seal", () => {
    const home = providerHome(ANA, "gemini");
    writeLogin(ANA, "gemini", ".gemini/oauth_creds.json", "GEMINI-1");
    sealIdleProviderHome(home);
    writeLogin(ANA, "gemini", ".gemini/oauth_creds.json", "GEMINI-PLAIN-COPY");
    forgetProviderLogin(home);
    expect(NodeFS.existsSync(NodePath.join(home, ".gemini", "oauth_creds.json"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(home, ".gemini", "oauth_creds.json.lpvault"))).toBe(
      false,
    );
    expect(NodeFS.existsSync(vaultRevokedMarker(base, ANA, "gemini"))).toBe(true);
    expect(readVaultedFile(home, ".gemini/oauth_creds.json")).toBeNull();
    // Connecting again clears the marker.
    writeLogin(ANA, "gemini", ".gemini/oauth_creds.json", "GEMINI-2");
    sealIdleProviderHome(home);
    expect(NodeFS.existsSync(vaultRevokedMarker(base, ANA, "gemini"))).toBe(false);
  });
});

describe("the master key", () => {
  it("from LOGICPACKS_LOGIN_KEY: copied to a 0600 runtime file for the runner, not the disk", () => {
    const state = freshHost();
    const runtime = NodePath.join(base, "run", "login.key");
    expect(state.keyCandidates[0]).toBe(runtime);
    expect(NodeFS.statSync(runtime).mode & 0o777).toBe(0o600);
    expect(NodeFS.existsSync(NodePath.join(base, "secrets", "login.key"))).toBe(false);
  });

  it("from the key file, generated 0600 on first start", () => {
    resetLoginVaultForTests();
    const host = NodePath.join(root, "generated");
    const state = configureLoginVault(host, { env: {}, generate: true })!;
    const file = NodePath.join(host, "secrets", "login.key");
    expect(state.keyCandidates).toEqual([file]);
    expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(NodePath.dirname(file)).mode & 0o777).toBe(0o700);
    expect(NodeFS.readFileSync(file).length).toBe(32);
    resetLoginVaultForTests();
    expect(configureLoginVault(host, { env: {} })!.master.equals(state.master)).toBe(true);
  });

  it("no key, no encryption; a short key is refused", () => {
    resetLoginVaultForTests();
    expect(configureLoginVault(NodePath.join(root, "none"), { env: {} })).toBeNull();
    resetLoginVaultForTests();
    expect(() =>
      configureLoginVault(NodePath.join(root, "short"), { env: { LOGICPACKS_LOGIN_KEY: "abcd" } }),
    ).toThrow();
  });

  it("knows which homes are a member's", () => {
    expect(vaultHomeOwner(`/srv/lp-v2/members/${ANA}/.lp/codex`)).toEqual({
      digest: ANA,
      kind: "codex",
    });
    expect(vaultHomeOwner("/root/.codex")).toBeNull();
  });
});
