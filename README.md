# LogicPacks

LogicPacks is the best way for teams and AI agents to work together. People and their coding agents
(Claude Code, Codex, OpenCode and others) share projects, threads and context in one workspace, and hand work
to each other without losing the thread.

[Website](https://logicpacks.io) · [Download](https://logicpacks.io/download) · [About](https://logicpacks.io/about.md) · [Safety](https://logicpacks.io/safety.md)

## What is open source (MIT)

This repository is the collaborative workspace:

- the desktop app (Electron) and the web client
- the local server that runs agents, terminals, git and project files on your machine
- collaboration and host sharing: invites, shared threads, the project feed, sync between teammates
- the `lp` helper and the MCP server that let any agent join a workspace

You can read it, run it, change it and fork it. It is released under the [MIT License](./LICENSE).

## Hosted services

These are provided by LogicPacks as hosted services and are enabled per account. They are not part of the
MIT code in this repository:

- LogicPacks Cloud (coming soon)
- Talent
- Apps and Packs
- Enterprise

The app verifies signed entitlements for these services. Only the hosted service can issue them, so the
checking code is public and the capability is not something you can switch on locally.

## Download

Get the latest Mac build from https://logicpacks.io/download, or run:

```bash
curl -fsSL https://logicpacks.io/install.sh | bash
```

## Build from source

Requirements: macOS, Linux or Windows, and Git. [Vite+](https://viteplus.dev) (`vp`) provides the pinned
Node version.

```bash
curl -fsSL https://vite.plus | bash     # Windows: irm https://vite.plus/ps1 | iex
git clone https://github.com/Tech-Realm/logicpacks.git
cd logicpacks
vp i
vp run dev            # server and web client; open the pairing URL it prints
vp run dev:desktop    # desktop app in development mode
```

Checks:

```bash
vp run typecheck
vp run test
```

Package a desktop build (unsigned) with `vp run dist:desktop:dmg` (macOS), `dist:desktop:linux` or
`dist:desktop:win`. More detail is in [docs/operations/development.md](./docs/operations/development.md).

## Architecture

- `apps/server` is the local server. It owns provider processes (Claude Code, Codex and others), terminals,
  git, project files and state, and exposes them over authenticated RPC and HTTP.
- `apps/web` is the React client. It is served by the server and bundled into the desktop app.
- `apps/desktop` is the Electron shell: it starts the bundled server, owns windows, updates and OS integration.
- `packages/contracts` defines the wire protocol and schemas shared by every client and the server.
- `packages/client-runtime` holds connection and domain state shared by clients.
- `packages/helper` is the `lp` helper and MCP tooling that outside agents use to join a workspace.
- `packages/provider-*` adapt each agent runtime; `packages/source-control-*` adapt git hosts.

Execution stays in the environment that owns the workspace. Clients, including remote ones, never substitute
their own filesystem or credentials. The longer write-up is in [docs/internals/overview.md](./docs/internals/overview.md).

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

## Credits

Developed by [TechRealm](https://techrealm.online) and operated by Al Jash Trading. Third-party notices are in
[third-party-licenses](./third-party-licenses).
