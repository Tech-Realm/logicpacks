# Recipes

A recipe (`recipe/1`, `packages/contracts/src/recipe.ts`) says what a project is for. It replaced v1 packs in everything users see; `recipeFromPackManifest` converts a v1 `pack.json`, including the `recipe` section the app-recipes branch added to it.

## Where things live

- Catalog: `packages/shared/src/recipes/builtin.ts`. Code has no `integration`; app recipes carry detect, launch, adapter, tools and op-log spec.
- Gate: `recipeAccess` in `packages/shared/src/recipes/runtime.ts`. The picker, project creation and the launch route all ask it. Members are treated as `web` (Code only); the operator as `desktop`.
- A project's recipe is the committed `.logicpacks/recipe.json` (`{ "recipe": "blender" }`), not a database row, so Sync carries it to the cloud host and teammates. No file means Code.
- Blender adapter: `apps/server/src/recipes/`. The bridge add-on, the `logicpacks recipe` CLI, MCP over stdio and `blender_merge`.
- Live view: the bridge's `view` command, served by `GET /api/lp/recipes/view` (operator only) and shown by `apps/web/src/logicpacks/RecipeAppPanel.tsx` as the right panel's `app` surface. It returns a PNG frame plus the scene outline, each object with its last op's actor. The header control opens the panel once per thread in the desktop app.

## Traps

- **The add-on is a string.** `blenderBridgeAddon.ts` holds the Python source and launch writes it to `<session>/assets`. Blender cannot read files inside the desktop app's `app.asar`, and the server bundle has no asset copy step.
- **Agents only get the tools if Claude allows them.** Launch writes the MCP server to `.mcp.json` and adds it to `enabledMcpjsonServers` in `.claude/settings.local.json`. Claude sessions skip project servers nobody approved. Both files hold machine paths, so recipe projects gitignore them.
- **The MCP command is this install's `logicpacks`.** `currentCliInvocation` prefers the desktop CLI shim (`LOGICPACKS_CLI_PATH`), else this runtime plus entry with `ELECTRON_RUN_AS_NODE=1` when the backend runs under Electron. The app process itself is spawned without that variable.
- **The cloud host is headless.** With `LOGICPACKS_CLOUD_HOST=true` the launch route starts the app with its `headlessArgs`.
- **Draw the viewport, do not screenshot it.** `screen.screenshot_area` returns the window's last drawn frame, which goes stale once Blender is behind other windows, and forcing a redraw from a timer (`wm.redraw_timer`) returned a 1x1 image. The view uses `render.opengl(view_context=True)` with a window, and a Workbench render without one (a temporary camera frames the scene when it has none). Both restore the render settings and leave no object or op behind.

## Testing

- `node apps/server/scripts/recipe-blender-e2e.ts`: real headless Blender, branch, clashing edits, merge.
- `node apps/server/scripts/recipe-view-probe.ts [outDir] [--window]`: the live view against real Blender, headless or in a real window.
- `node apps/web/e2e/logicpacks-recipes.e2e.mjs`: web gating, Blender project, headless open, MCP edit, live view. Needs a built `apps/web/dist`, Chrome and Blender.

## Any app (live sharing)

- Protocol: `packages/contracts/src/appStream.ts`. Server hub: `apps/server/src/logicpacks/appStream.ts` (rooms, grants with expiry, kill, input forwarding only with a live grant, JPEG relay) behind `/api/lp/appstream/{ticket,state,ws}` in `appStreamHttp.ts`. The server only relays signalling; video is WebRTC peer to peer from the host's renderer.
- Host capture: Electron `desktopCapturer` window sources and `getUserMedia({ chromeMediaSource: "desktop" })` in the renderer (ScreenCaptureKit underneath on current macOS). Input: `lp-appctl`, a small Swift helper compiled from `apps/desktop/src/appShare/appctl.swift.ts` (CGEvent; keys with `postToPid`; mouse only inside the shared window and only when it is the top window at that point). The host re-checks the grant before every injected event.
- Ops: `apps/server/src/logicpacks/appOps.ts` (`blender.*` over the bridge socket with its token, `resolve.*` through DaVinciResolveScript, `app.*` through JXA, System Events and `screencapture`), `POST /api/lp/apps/run` in `appOpsHttp.ts`, `lp app` in `packages/helper/src/app.ts`. Mutating ops need the operator or a grant. Actions append to `<project>/.logicpacks/apps/actions.jsonl`.
- Recipes for shared apps: `packages/shared/src/recipes/appGuides.ts`. The ledger's turn context adds `<logicpacks_shared_app>` with the guide while an app is shared (`sharedAppContext.ts`), and `GET /api/lp/apps/ops` returns it.
- Gate: `requireFeature(caller, "apps")` (`features.ts`, over the shared `FeatureAccess` store: host owner and staff always, members after redeeming an access code) on the ticket, ops, run and log routes; the web uses `useFeature("apps")` from `logicpacks/features.ts` and renders nothing for locked accounts.
- ICE: STUN `stun:stun.l.google.com:19302` by default; `LOGICPACKS_ICE_SERVERS` takes a JSON list (or `none`). Beyond the LAN a self-hosted coturn (BSD) is the documented next step; nothing paid.

Traps: Stage Manager captures background windows as thumbnails (the host focuses the window on share and warns when it shrinks). React strict mode closes and reconnects a session, so `AppStreamSession.connect` is generation-guarded. The Blender bridge now requires the token from `bridge.json` on every call.

Testing: `apps/server/src/logicpacks/appStream.test.ts` (hub rules), `packages/shared/src/recipes/appGuides.test.ts`, and `apps/web/e2e/logicpacks-app-stream.e2e.mjs` (real desktop host over CDP, Chrome member, Blender; see its header for bringing the stack up). Benchmarks: `apps/web/e2e/logicpacks-app-stream.bench.mjs`, results in `research/benchmarks.json`.
