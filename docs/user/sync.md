# Sync to the cloud

A project you add on your computer is **Not synced**: it lives only there, and nobody in your workspace can see it. Sync puts it on your team's cloud host so everyone works on the same project, and agents keep working there when your computer is off.

## Sync a project

Press **Sync** on the "Not synced" notice above the composer, choose **Sync to cloud** from the project's context menu, or tell the project's agent "sync this to the cloud". All three do the same thing:

1. The project gets a private GitHub repository through `gh` (or keeps the remote it already has) and is pushed.
2. It is added to the cloud host, in your current workspace there, so the workspace's members get it.
3. From then on, every copy of the project keeps itself in step.

The first time, LogicPacks asks for your cloud host's address and your account on it. It remembers them for later projects.

On the cloud host, open your avatar menu and **Connect Claude**: agents there run on your own Claude login, which is what lets them keep going while your laptop is closed.

## Bring people in

On the cloud host, **Invite** next to the workspace name gives a link (and a prompt to paste into their Claude Code). Anyone who opens it joins the workspace and gets all its projects. To give one project to someone outside the workspace, press **Share** next to the project's badge and enter their email or LogicPacks name. Remove them from either place to take access away.

## The badge

Every project shows where it lives, next to its name:

- **Not synced**: only on this computer.
- **Syncing**: being pushed or set up.
- **Synced**: on the cloud host and in step with the repository.
- **Conflict**: someone changed the same lines you did. See below.
- **Sync paused**: something failed, such as a lost GitHub login. The notice says what, with **Retry**.

## How copies stay in step

Your computer and the cloud host each save, pull and push the project's main checkout about every 20 seconds. Two things to know:

- Changes are committed for you between agent turns ("LogicPacks: save work on this computer"). While an agent is mid-turn, the project is only fetched, never changed under it.
- Agents in a synced project also run their own background loop to fetch, rebase and push their branch, and they tell you about conflicts they can't settle.

## Conflicts

When your change and a teammate's touch the same lines, the badge turns to **Conflict** and the notice names the files and who changed them. Pick **Keep mine** or **Keep theirs** for the conflicting lines (everything else from both sides is kept), or ask the agent to merge them by hand. Your checkout is never left half merged.

## Running a cloud host

A cloud host is an ordinary LogicPacks server started with `LOGICPACKS_CLOUD_HOST=true`, signed in to GitHub with `gh auth login` so it can clone and push private repositories. Laptops point at it with the address they enter when they first sync (the default comes from `LOGICPACKS_CLOUD_URL`). `LOGICPACKS_SYNC_SECONDS` sets how often each copy syncs (default 20, `0` turns the loop off) and `LOGICPACKS_SYNC_AUTOCOMMIT=false` stops it committing work for you.
