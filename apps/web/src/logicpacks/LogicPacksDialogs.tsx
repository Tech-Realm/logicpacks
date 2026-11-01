import { CopyIcon, SparklesIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import {
  inviteAgentPrompt,
  lpAbsoluteUrl,
  lpApi,
  type LpSession,
  type LpWorkspaceMember,
  type LpWorkspaceRole,
} from "./api";
import { ConnectAgentForm } from "./ConnectAgent";
import { featuresApi } from "./features";
import { ShareProjectDialog } from "./ShareProjectDialog";
import { AddProjectForm } from "./forms";
import { SyncProjectDialog } from "./SyncControls";
import { GetLocalDialog, UploadFilesDialog } from "./ProjectFilesControls";
import {
  closeLpDialog,
  refreshLogicPacksSession,
  reloadAtHome,
  useLogicPacksSession,
  useLpDialog,
  type LpDialog,
} from "./store";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

const copy = (text: string, title: string) =>
  void writeTextToClipboard(text)
    .then(() => toastManager.add({ type: "success", title }))
    .catch((error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: errorText(error) }),
    );

const ROLE_LABEL: Record<LpWorkspaceRole, string> = { owner: "Owner", member: "Member" };

/** One dialog for a workspace: invite, people and roles, and the rarely used rest under Advanced. */
function ManageWorkspaceDialog({
  session,
  workspaceId,
}: {
  session: LpSession;
  workspaceId: string;
}) {
  const workspace = session.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  const [members, setMembers] = useState<ReadonlyArray<LpWorkspaceMember>>([]);
  const [canManage, setCanManage] = useState(false);
  const [invitePath, setInvitePath] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState(workspace?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    lpApi
      .members(workspaceId)
      .then((result) => {
        setMembers(result.members);
        setCanManage(result.canManage);
      })
      .catch((cause) => setError(errorText(cause)));

  const loadOnOpen = useEffectEvent(() => {
    void load();
    void lpApi
      .invite(workspaceId)
      .then((result) => setInvitePath(result.path))
      .catch((cause) => setError(errorText(cause)));
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the workspace's people and its invite link when the dialog opens
  useEffect(() => loadOnOpen(), []);

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    void action()
      .then(() => load())
      .then(() => refreshLogicPacksSession())
      .catch((cause) => setError(errorText(cause)));
  };

  if (!workspace) return null;
  const inviteUrl = invitePath === null ? null : lpAbsoluteUrl(invitePath);
  const me = session.user?.userId ?? null;

  const addPerson = (event: FormEvent) => {
    event.preventDefault();
    const user = person.trim();
    if (user.length === 0) return;
    run(() => lpApi.addMember(workspaceId, user, "member").then(() => setPerson("")));
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{workspace.name}</DialogTitle>
        <DialogDescription>
          Everyone here works in all of this workspace's projects, with their own agents.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2" aria-label="Invite">
            <h3 className="text-sm font-medium">Invite link</h3>
            <div className="flex gap-2">
              <Input
                aria-label="Invite link"
                className="flex-1"
                readOnly
                value={inviteUrl ?? "Creating link"}
                data-testid="lp-invite-link"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={inviteUrl === null}
                onClick={() => inviteUrl && copy(inviteUrl, "Invite link copied")}
              >
                <CopyIcon />
                Copy
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={inviteUrl === null}
                onClick={() =>
                  inviteUrl &&
                  copy(
                    inviteAgentPrompt({ workspaceName: workspace.name, url: inviteUrl }),
                    "Prompt copied. They paste it into their Claude Code.",
                  )
                }
              >
                <SparklesIcon />
                Copy prompt for their Claude Code
              </Button>
              <span className="text-xs text-muted-foreground">
                Anyone with the link joins as a member.
              </span>
            </div>
          </section>

          {canManage ? (
            <form className="flex flex-col gap-2" onSubmit={addPerson} aria-label="Add a person">
              <h3 className="text-sm font-medium">Already on LogicPacks?</h3>
              <div className="flex gap-2">
                <Input
                  aria-label="Email or name"
                  className="flex-1"
                  placeholder="Email or LogicPacks name"
                  value={person}
                  onChange={(event) => setPerson(event.target.value)}
                />
                <Button size="sm" type="submit" data-testid="lp-add-person">
                  Add
                </Button>
              </div>
            </form>
          ) : null}

          <section className="flex flex-col gap-1" aria-label="People">
            <h3 className="text-sm font-medium">People ({members.length})</h3>
            <ul className="flex flex-col divide-y">
              {members.map((member) => (
                <li
                  key={member.user.userId}
                  className="flex items-center gap-3 py-2"
                  data-testid="lp-member-row"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {member.user.displayName}
                      {member.user.userId === me ? " (you)" : ""}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {member.user.email}
                    </div>
                  </div>
                  {canManage ? (
                    <Select
                      value={member.role}
                      onValueChange={(value) => {
                        if (value === null || value === member.role) return;
                        run(() =>
                          lpApi.setRole(workspaceId, member.user.userId, value as LpWorkspaceRole),
                        );
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Role for ${member.user.displayName}`}
                        className="w-28"
                        size="sm"
                      >
                        <SelectValue>{ROLE_LABEL[member.role]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="owner">Owner</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                      </SelectPopup>
                    </Select>
                  ) : (
                    <span className="text-xs text-muted-foreground">{ROLE_LABEL[member.role]}</span>
                  )}
                  {canManage || member.user.userId === me ? (
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      aria-label={`Remove ${member.user.displayName}`}
                      onClick={() => {
                        const leaving = member.user.userId === me;
                        run(async () => {
                          await lpApi.removeMember(workspaceId, member.user.userId);
                          if (leaving) await reloadAtHome();
                        });
                      }}
                    >
                      {member.user.userId === me ? "Leave" : "Remove"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          {canManage ? (
            <section className="flex flex-col gap-3" aria-label="Advanced">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={advanced} onCheckedChange={setAdvanced} />
                Advanced
              </label>
              {advanced ? (
                <div className="flex flex-col gap-3">
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(() => lpApi.renameWorkspace(workspaceId, name));
                    }}
                  >
                    <Input
                      aria-label="Workspace name"
                      className="flex-1"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <Button size="sm" type="submit" variant="outline">
                      Rename
                    </Button>
                  </form>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(() => lpApi.resetInvite(workspaceId).then((r) => setInvitePath(r.path)))
                      }
                    >
                      Reset invite link
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() =>
                        void (async () => {
                          const confirmed =
                            (await requestConfirmDialog(
                              `Delete ${workspace.name}?\nIts projects stay on this host, but nobody reaches them through this workspace anymore.`,
                              { variant: "destructive" },
                            )) ?? window.confirm(`Delete ${workspace.name}?`);
                          if (!confirmed) return;
                          run(async () => {
                            await lpApi.deleteWorkspace(workspaceId);
                            await reloadAtHome();
                          });
                        })()
                      }
                    >
                      Delete workspace
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {workspace.projectIds.length} project
                    {workspace.projectIds.length === 1 ? "" : "s"} in this workspace. To share one
                    project with someone outside it, use Share on the project.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
    </>
  );
}

function NewWorkspaceDialog() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void lpApi
          .createWorkspace(name)
          .then(() => reloadAtHome())
          .catch((cause) => {
            setError(errorText(cause));
            setPending(false);
          });
      }}
    >
      <DialogHeader>
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>A separate place with its own projects and people.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Workspace name"
            autoFocus
            placeholder="Workspace name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" size="sm" disabled={pending} data-testid="lp-create-workspace">
          Create and switch
        </Button>
      </DialogFooter>
    </form>
  );
}

const FEATURE_NAMES: Record<string, string> = {
  packs: "Packs",
  talent: "Vetted freelancers",
  apps: "Apps",
  freelancer_jobs: "Freelancer jobs",
  cloud_agents: "Cloud agents",
};

/** Account: unlock gated features with an access code from LogicPacks. */
function RedeemCodeDialog() {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() === "" || pending) return;
    setPending(true);
    try {
      const result = await featuresApi.redeem(code.trim());
      toastManager.add({
        type: "success",
        title: "Code redeemed",
        description:
          result.unlocked.length > 0
            ? `Unlocked: ${result.unlocked.map((feature) => FEATURE_NAMES[feature] ?? feature).join(", ")}.`
            : "Your account already had these features.",
      });
      closeLpDialog();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Code not redeemed",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    setPending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Redeem access code</DialogTitle>
        <DialogDescription>Codes from LogicPacks unlock extra features.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Input
          value={code}
          autoFocus
          placeholder="LP-XXXX-XXXX"
          data-testid="lp-redeem-code-input"
          onChange={(event) => setCode(event.target.value)}
        />
      </DialogPanel>
      <DialogFooter>
        <Button
          type="submit"
          size="sm"
          disabled={pending || code.trim() === ""}
          data-testid="lp-redeem-code-submit"
        >
          Redeem
        </Button>
      </DialogFooter>
    </form>
  );
}

function DialogBody({ dialog, session }: { dialog: LpDialog; session: LpSession }) {
  switch (dialog.kind) {
    case "manage":
      return (
        <ManageWorkspaceDialog
          key={dialog.workspaceId}
          session={session}
          workspaceId={dialog.workspaceId}
        />
      );
    case "new-workspace":
      return <NewWorkspaceDialog />;
    case "share-project":
      return (
        <ShareProjectDialog
          key={dialog.projectId}
          projectId={dialog.projectId}
          title={dialog.title}
        />
      );
    case "sync-project":
      return (
        <SyncProjectDialog
          key={dialog.projectId}
          projectId={dialog.projectId}
          title={dialog.title}
          session={session}
        />
      );
    case "get-local":
      return (
        <GetLocalDialog key={dialog.projectId} projectId={dialog.projectId} title={dialog.title} />
      );
    case "upload-files":
      return (
        <UploadFilesDialog
          key={dialog.projectId}
          projectId={dialog.projectId}
          title={dialog.title}
          folder={dialog.folder}
          items={dialog.items}
        />
      );
    case "add-project":
      return (
        <>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              {`It goes into ${
                session.workspaces.find((w) => w.workspaceId === session.currentWorkspaceId)
                  ?.name ?? "this host"
              }, shared with everyone there.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <AddProjectForm session={session} onCreated={() => closeLpDialog()} />
          </DialogPanel>
        </>
      );
    case "redeem-code":
      return <RedeemCodeDialog />;
    case "connect-claude":
      return (
        <>
          <DialogHeader>
            <DialogTitle>Connect your agent</DialogTitle>
            <DialogDescription>
              Agents you start on this host use your own login: Claude, Codex, OpenCode or Gemini
              CLI.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ConnectAgentForm onConnected={() => undefined} />
          </DialogPanel>
        </>
      );
  }
}

/** Mounted once at the root, like the app's other dialog hosts. */
export function LogicPacksDialogHost() {
  const dialog = useLpDialog();
  const { session } = useLogicPacksSession(false);
  if (dialog === null || session === null) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && closeLpDialog()}>
      <DialogPopup>
        <DialogBody dialog={dialog} session={session} />
      </DialogPopup>
    </Dialog>
  );
}
