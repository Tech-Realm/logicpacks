# FAQ

## Is LogicPacks a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. LogicPacks uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. LogicPacks = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :)

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Pi, or Muse Code. [Provider setup](./install.md#providers)

## Why use LogicPacks instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `logicpacks connect` on any box and drive it from anywhere.
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use LogicPacks with my Claude Code subscription?

Yes.

## How much does LogicPacks cost?

Nothing. There's no way to pay us to use LogicPacks. You bring your own sub. It is free and open source (MIT). You still pay your provider like you already do.

## How do I use LogicPacks remotely?

Your agents run wherever LogicPacks runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `logicpacks connect` on that machine and you get really good remote support. LogicPacks Connect is the easy path. LAN pairing and Tailscale work too, and [app.logicpacks.io](https://app.logicpacks.io) is the web client. [Remote access](./remote-access.md)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does LogicPacks support local models?

No. LogicPacks is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to LogicPacks servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. With LogicPacks Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine). Our relay sets up the link. It does not proxy your HTTP or WebSocket sessions. LogicPacks does send basic product usage events (provider, model, token totals, that kind of thing). No prompts, no file contents. That is the same on Tailscale, LAN, or LogicPacks Connect. Set `LOGICPACKS_TELEMETRY_ENABLED=false` if you want it off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings > Storage** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `logicpacks` binary for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
