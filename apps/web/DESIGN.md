# LogicPacks design language

This file covers what makes the app look like LogicPacks, so new features pick it up from
tokens and primitives and nobody has to restyle them one by one. The colour work (monochrome, colour only for meaning)
was done earlier and is in `src/index.css`. This file is about identity and form.

## The idea: a pack holding logic

The mark (`assets/brand/logicpacks-mark.svg`, the same one as on logicpacks.io) is a
rounded square holding a dot. The rest of the system comes from it:

| Mark            | In the UI                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| The pack        | Containers are soft "pack frames" (composer, user turns, the open sidebar row, dialogs).                           |
| The dot         | A leading icon on an action sits in a round well. Status is a dot, not a tinted fill.                              |
| One square      | The send button is the only rounded-square control: an outline when empty, filled with ink when ready.             |
| The mark itself | It stands for packed agent work: in the "Worked for" fold, the live "Working for" row, and the workspace switcher. |

## Tokens (`src/brand.css`)

| Token                                               | Value                            | Use                                                     |
| --------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `--lp-radius-pill` / `rounded-pill`, `rounded-full` | 9999px                           | Every button, chip, badge, composer control             |
| `--lp-radius-frame` / `rounded-frame`               | 20px                             | Composer, user turns, first-run panels                  |
| `--lp-radius-panel` / `rounded-panel`               | 16px                             | Dialogs, sheets                                         |
| `--lp-radius-float` / `rounded-float`               | 14px                             | Menus, popovers                                         |
| `--lp-radius-row` / `rounded-row`                   | 10px                             | Sidebar and list rows, fields                           |
| `--radius`                                          | 10px (upstream 8px)              | Feeds `rounded-sm`…`rounded-3xl`, 2px softer everywhere |
| `--lp-hairline`, `--lp-hairline-strong`             | foreground at 12–13% / 22–24%    | Outlines (`border-hairline`, `ring-hairline-strong`)    |
| `--lp-well`, `--lp-well-strong`                     | foreground at 8–9% / 13–15%      | Icon wells and secondary fills (`bg-well`)              |
| `--lp-ease` / `ease-lp`                             | `cubic-bezier(0.22, 1, 0.36, 1)` | All UI transitions                                      |
| `--lp-dur-1/2/3`                                    | 120 / 200 / 320ms                | Hover and press / state changes / entrances             |
| `--ring`                                            | foreground at 55%                | Focus rings are ink, as on logicpacks.io                |

## Type

- **Inter Variable with optical sizing** (`@fontsource-variable/inter/opsz.css`,
  `font-optical-sizing: auto`). Headings get Inter's display cut, and body text gets the text cut. The landing
  page uses Inter too, so the app and the site share one family.
- **Headings are regular weight with tight tracking**, as on logicpacks.io: the empty
  state is 32px/400 at -0.03em, dialog titles are 22px/400 at -0.025em. Bold is for UI
  labels, not headlines.
- **JetBrains Mono Variable** (self-hosted, OFL, `src/assets/fonts`) is the default code
  font, the same mono as the landing page. Users can still pick their own in Settings → Appearance.
- UI labels are 13px medium with -0.006em tracking. Chips are 11px (10.5px small) medium,
  in sentence case. Do not use uppercase labels.

## Primitives

**Button** (`components/ui/button.tsx`)

- Always a pill. Icon sizes are circles.
- `default`: solid ink. `outline`: hairline, transparent, a faint fill on hover.
  `secondary`: a well fill. No inset sheen, no drop shadow.
- Pressing dims the button to 75% and does not shrink it.
- `outline` and `secondary` buttons with a label get `data-lp-well`. The leading icon sits in
  a round well that darkens on hover. This is the Invite, Share and Sync look.
- Focus: a 2px ink ring, offset 2px.

**Badge** (`components/ui/badge.tsx`)

- Pill, hairline outline, no tinted fill. Status variants tint the label and border only.
- Add `data-lp-dot` to lead with a status dot: `""` filled, `"ring"` hollow (not
  started), `"pulse"` (in progress). Sync badges use this: Synced, Not synced, Syncing.

**Composer**: a pack frame (`rounded-frame`). Toolbar controls are ghost pills. The send
button is the rounded-square "pack".

**Sidebar**: the workspace switcher leads with the mark. The open thread is framed by a
hairline inside a faint fill instead of floating as a white card. Rows use `rounded-row`.

**Thread**: user turns are pack frames with the corner nearest the sender tucked in
(`rounded-br-md`). The "Worked for Xs" fold is a pill that leads with the mark.

**Dialogs, menus and popovers**: titles use the display style. Menus use `rounded-float` with
`rounded-lg` items.

**Server pages** (`apps/server/src/logicpacks/loginPage.ts`: sign in, account, join,
connect a terminal) and the Codex sign-in callback page use the same rules: the mark and
wordmark, a regular-weight heading, pill buttons and ink focus.

## Motion

- One curve (`ease-lp`) and three durations. Transitions cover colour, border and opacity.
  Layout does not animate on hover.
- The boot shell's mark breathes while the bundle loads. The live "Working for" mark pulses.
  Nothing else moves unless the user acts.
- `prefers-reduced-motion: reduce` cuts every animation and transition to 1ms in
  `brand.css`, so `animationend` handlers still fire.

## Icons

- Lucide stays, at its default 2px stroke. Sizes come from the primitives: 16px in
  buttons on desktop and 18px on touch, 12–14px in chips.
- Use `components/LogicPacksMark.tsx` for the mark (`LogicPacksMark`, which follows
  `currentColor`) and the app tile (`LogicPacksAppIcon`).

## Brand assets

`assets/brand/logicpacks-mark.svg` is the only source for the mark. Run
`scripts/render-logicpacks-icons.sh` to render the favicon.ico, the PNG favicons,
apple-touch, the manifest icons (including the maskable one), the macOS 1024 and `.icns`,
and the iOS, Linux and Windows icons for every channel.

## Layout: the project room

LogicPacks is laid out for one person reading a chat log: a flush sidebar, a breadcrumb, a centred
column and a floating card. LogicPacks is a shared project with people and agents working in
it, so the layout is built around that. Everything here lives in shared components
(`ui/sidebar`, `ChatHeader`, `ThreadDetailsCard`, `brand.css`), so new screens inherit it.

**Canvas and sheet.** The window is a grey canvas (`--lp-canvas`). The sidebar sits straight on
it with no border. The open project is one sheet on top: inset 8px from the window, `rounded-panel`,
outlined with a hairline and no shadow (`SidebarInset`). The top bar, the timeline, the composer and
the details rail are all inside that sheet, so the whole project reads as one unit. On phones the
sheet runs edge to edge.

```
 canvas ─────────────────────────────────────────────────────────────┐
 │ ◻ Ana's workspace       ╭ sheet ─────────────────────────────────╮ │
 │ (A)(M)(O) +             │ [▣ Team site ○ Not synced] Title ▾    (A)(M) Share │◫◫◫│ │
 │ ( Search            )   │                                │ Machine           │ │
 │  Thread rows            │    ╭ you ───────────────╮      │  Sam's MacBook   │ │
 │                         │    ╰────────────────────╯      │ Branch            │ │
 │                         │  ◻ Worked for 5s               │  main             │ │
 │                         │  │ read  edit  ran             │                   │ │
 │                         │  │ Agent reply                 │                   │ │
 │                         │  ╭ composer ─────────────╮     │                   │ │
 │                         │  ╰───────────────────────╯     │                   │ │
 │ (A) Ana  ⚙ ⑂ ▤          ╰────────────────────────────────────────────────────╯ │
 └───────────────────────────────────────────────────────────────────────┘
```

**Sidebar: the workspace.** The header is a workspace block: the mark and the workspace name,
then a people row with everyone in the workspace as ink initials and a round Invite button at
its end. Search is a pill field. The scripted demo (/demo/machine) is
never linked from the signed-in app; it stays reachable by direct URL for the film and landing.
The live "Any app" (/machine) sits under a "Beta" label only for accounts with the apps feature. The footer is an identity row:
your avatar, your name and your agent's state, with Settings, Pull requests and Usage as
plain icons after it.

**Top bar: the room header.** The project is a pack chip, one hairline pill holding the
project icon, its name and its sync state, followed by the thread title. The right side
belongs to people: who is in the project (an avatar stack; people here now get a filled dot),
Share, then one tool tray, a single pill grouping Who's working, Branch and Request
assistance. The panel toggles sit last.

**Thread: agent work hangs on a spine.** User turns stay right-aligned pack frames. An
agent turn starts at the mark in "Worked for" and a hairline runs down its left edge through
the tool calls, diffs and reply until the next person speaks, so each turn reads as one
packed unit. Work rows are indented on that spine, not in the column's left margin. The
reading column is 44rem (upstream 46rem).

**Details rail.** The machine and branch controls are not a floating glass card. They form a
rail docked to the sheet's right edge, full height, with a hairline on its left and plain
section headings.

**Empty states.** A new thread's headline is left-aligned with the composer, not centred, and
the people row sits under it so you can see who you are building with or invite someone.

**Lists of things are one frame.** Several items side by side (experts, first-run steps)
sit in one hairline frame divided into cells, as on logicpacks.io, not in a grid of separate
cards with shadows.

**Sign-in and account pages** (`loginPage.ts`) use the same canvas and sheet: a grey page with
one hairline sheet, no glow and no shadow.

**Colour.** Black, white and grey only. People's avatars are ink (here now) or a well (not
here); live dots are ink. Diff colours and user-chosen project icons keep their colour.

| Token                      | Light                      | Dark                              |
| -------------------------- | -------------------------- | --------------------------------- |
| `--lp-canvas`              | background + 5% foreground | the app background                |
| `--lp-sheet`               | the app background         | background + 4.5% foreground      |
| `--chat-content-max-width` | 44rem (Comfortable)        | same; Wide and Full are unchanged |

## What still comes from upstream, on purpose

- Topbar height and the resizable sidebar's limits. These come from usage, not from branding.
- Diff and syntax colours, the terminal font (Ghostty needs its metrics) and the
  presence and guest hues. Colour carries meaning there.
- The Dev and Nightly sidebar artwork (`SidebarStageBackdrop`). Only developer and nightly
  builds show it, and release builds show nothing.
- Internal names: `logicpacks:` storage keys, `LOGICPACKS_*` environment variables, the `logicpacks` CLI and
  protocol and bundle ids.
