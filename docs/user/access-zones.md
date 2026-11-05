# Access zones

When you share a project from your own computer, each person you share with gets a seat made of
three zones. One system decides everything a member can do: the Read only role is just the Read
only preset.

| Preset | AI | Files | Compute |
| --- | --- | --- | --- |
| Chat only | host's agents | none | off |
| Can edit (default) | host's agents | read and write, no secret files | off |
| Full access | host's agents | read and write, secret files | on |
| Read only | none | read | off |

Set the default for everyone in the Share dialog (it is what the share link gives), and override
one person in the same dialog. Changes apply at once, including to open terminals and agent runs.

## What each zone really guarantees

**AI.** Members spend your agent subscription (Claude, Codex, OpenCode, only those installed here).
They can switch to their own login at any time. With AI off, the composer offers "Request host's
Claude"; you see the request in the Share dialog and Allow or Deny it.

**Files.** Enforced on file, upload, zip, git and sync requests. Secret files (`.env`, keys) stay
hidden unless you allow them. An agent a member prompts reads the project to answer: Claude is told
not to open secret files, other agents are not restricted. An agent allowed to edit can write any
file in the project.

**Compute.** Off blocks the terminal and the agent's shell tool. It cannot stop an agent you let
edit files from writing code that someone later runs (a script, a git hook, `t3.json`). Host MCP
servers and skills are your tools and are not limited. On, a member's terminal runs on your
computer. On macOS it is wrapped in a Seatbelt profile that limits writes to the project and the
member's home; reads, network and programs are not limited. On Windows and Linux there is no sandbox:
it is a shell as your user on your real computer. Granting it needs a confirmation. Every member
terminal (open, close, the first command) is listed under Access activity in the Share dialog.

## How far agent limits hold

| Agent | Without Compute | Without file writes |
| --- | --- | --- |
| Claude | shell tools removed in every permission mode | edit tools removed |
| Codex | approvals a member cannot give, Codex sandbox | read-only sandbox |
| OpenCode | shell denied | edit denied |
| ACP agents | execute requests refused (an agent that never asks is not stopped) | edit requests refused |
