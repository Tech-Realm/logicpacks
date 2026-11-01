# Recipes

A recipe is what a project is for. **Code** is the default: agents and teammates work in one repository. App recipes let people and agents work in an app together, starting with **Blender** (preview).

## Start a project from a recipe

Open **Add project** and pick a recipe at the top. Code works everywhere. App recipes need the LogicPacks desktop app, because they open the app on your computer; on the web they show a link to download it. DaVinci Resolve, Browser, Godot, Reaper, Office and Sheets, and Jupyter are listed as coming soon.

## Work in Blender

1. In the desktop app, add a project with the **Blender** recipe.
2. Press **Open Blender** next to the project's name. Blender opens with the LogicPacks bridge loaded, and the first open saves the scene as `scene.blend`.
3. Ask the project's agent for changes ("add a camera looking at the cube"). Agents work through the Blender tools, not by editing the file, and every edit, by an agent or by hand, is logged per object.
4. The **App** tab in the side panel shows Blender where a code project shows its files: a live view of the viewport beside the scene outline. Each object shows who changed it last, and the strip below lists the latest edits.

From a terminal, `logicpacks recipe list` shows what this computer can run and `logicpacks recipe launch blender` opens Blender for the project in the current folder.

## Share and merge Blender work

A Blender project syncs like any other: Sync carries the scene, the recipe and each person's op log (`.logicpacks/blender/<branch>/oplog.jsonl`) to the cloud host and your teammates. On the cloud host, Blender runs without a window so agents keep working there.

To bring in someone's separate work, ask the agent to merge their op log. Edits that do not clash are applied; when two people changed the same property of the same object, your version stays and the clash is reported with both names.

Known gaps: edits inside a mesh (edit mode), materials, modifiers and animation are not merged yet.

## Any app: share an app live (Beta)

Any app shows a real app window from the host's Mac to everyone in the project, lets people take control when the host allows it, and lets agents work in the app through its recipe. It is access gated: you see **Any app** in the sidebar only when your account has it unlocked (the host owner always has it).

1. **Host** (desktop app): open **Any app**, pick the project, then pick a window under **Share an app**. macOS asks once for Screen Recording, and for Accessibility the first time someone controls the app.
2. **Everyone else**: open the same project under **Any app**. The window plays live (WebRTC, peer to peer; through the server as JPEG frames if a peer connection cannot be made).
3. **Control**: press **Request control**. The host chooses a time limit (5, 15 or 60 minutes) and presses **Allow**, or **Deny**. While you have control your mouse and keys go to that one window, and the host sees your named cursor. The host can **Revoke** one person, press **Stop all control**, or press Cmd Shift Esc anywhere to end every grant at once.
4. **Agents**: when an app is shared, agents in the project get its recipe in their next turn. They act with semantic ops, for example `lp app run blender.move Vase z 1.24`, and each op is logged under their name ("Mira's Claude: blender.move Vase z 1.24"). An agent's first edit takes a snapshot, and **Restore** in the Snapshots list goes back. Agents of people without control can only read.

Recipes for shared apps: **Blender** (objects, transforms, renders, snapshots), **DaVinci Resolve** (timelines and markers through Resolve's scripting, which needs DaVinci Resolve Studio; with the free edition agents use menus and keys) and **Any app** for everything else (AppleScript, menus, keys, screenshots, and clicks as a last resort). `lp app ops` lists the ops and prints the recipe for what is shared.

Keep the shared window in front while you share: with Stage Manager, windows in the side strip are captured as small thumbnails. The host view warns you and offers **Bring to front**.
