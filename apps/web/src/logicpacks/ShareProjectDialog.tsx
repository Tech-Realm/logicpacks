import { CopyIcon, LinkIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "../components/ui/dialog";
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
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { lpAbsoluteUrl, lpApi } from "./api";
import { looksLikeEmail, shareApi, type LpLinkExpiry, type LpShareOverview } from "./shareApi";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

const copy = (text: string, title: string) =>
  void writeTextToClipboard(text)
    .then(() => toastManager.add({ type: "success", title }))
    .catch(() => toastManager.add({ type: "info", title: "Copy this link", description: text }));

const EXPIRY_LABEL: Record<LpLinkExpiry, string> = {
  "1d": "1 day",
  "7d": "7 days",
  never: "Never",
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A note under a field. Muted, never a red dead end. */
function Hint({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="text-xs text-muted-foreground" role="status" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * Share one project: add people who have an account, invite people who do not (a pending
 * invite with its own link and an email), and one link anyone can join with.
 */
export function ShareProjectDialog({ projectId, title }: { projectId: string; title: string }) {
  const [data, setData] = useState<LpShareOverview | null>(null);
  const [person, setPerson] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<{ path: string; email: string } | null>(null);
  const [domain, setDomain] = useState("");
  const [domainOn, setDomainOn] = useState(false);
  const [linkHint, setLinkHint] = useState<string | null>(null);

  const load = () =>
    shareApi
      .overview(projectId)
      .then((next) => {
        setData(next);
        setDomain(next.link?.domain ?? "");
        setDomainOn(next.link?.domain != null);
      })
      .catch((cause) => setHint(errorText(cause)));
  const loadOnOpen = useEffectEvent(() => void load());
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads who the project is shared with when the dialog opens
  useEffect(() => loadOnOpen(), []);

  const run = (action: () => Promise<unknown>, onError = setHint) => {
    onError(null);
    void action()
      .then(() => load())
      .catch((cause) => onError(errorText(cause)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const user = person.trim();
    if (user.length === 0) return;
    if (user.includes("@") && !looksLikeEmail(user)) {
      setHint("That email looks incomplete. Check it and try again.");
      return;
    }
    setLastInvite(null);
    run(() =>
      shareApi.share(projectId, user).then((result) => {
        setPerson("");
        if (result.kind === "member") {
          setHint(`${result.member.user.displayName} can open ${title} now.`);
          return;
        }
        setLastInvite({ path: result.invite.path, email: result.invite.email });
        setHint(
          result.emailSent
            ? `${result.invite.email} has no account yet. We emailed them an invite.`
            : `${result.invite.email} has no account yet. Email is not set up on this host, so copy the invite link and send it to them.`,
        );
      }),
    );
  };

  const link = data?.link ?? null;
  const linkOn = link?.enabled === true;
  const linkUrl = link === null ? null : lpAbsoluteUrl(link.path);
  const updateLink = (change: Parameters<typeof shareApi.updateLink>[1]) =>
    run(() => shareApi.updateLink(projectId, change), setLinkHint);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share {title}</DialogTitle>
        <DialogDescription>
          People you add here can open this project even if they are not in its workspace.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          {data?.canManage === false ? (
            <Hint>Only the project owner can share it.</Hint>
          ) : (
            <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
              <div className="flex gap-2">
                <Input
                  aria-label="Email or name"
                  autoFocus
                  className="flex-1"
                  placeholder="Email or LogicPacks name"
                  value={person}
                  onChange={(event) => {
                    setPerson(event.target.value);
                    setHint(null);
                  }}
                />
                <Button size="sm" type="submit" data-testid="lp-share-project">
                  Share
                </Button>
              </div>
              {hint ? <Hint testId="lp-share-hint">{hint}</Hint> : null}
              {lastInvite ? (
                <div>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="lp-share-copy-new-invite"
                    onClick={() => copy(lpAbsoluteUrl(lastInvite.path), "Invite link copied")}
                  >
                    <CopyIcon />
                    Copy invite link
                  </Button>
                </div>
              ) : null}
            </form>
          )}

          <section className="flex flex-col gap-1" aria-label="People">
            <h3 className="text-sm font-medium">People</h3>
            <ul className="flex flex-col divide-y">
              {data?.members.map((member) => (
                <li key={member.user.userId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{member.user.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {member.user.email}
                    </div>
                  </div>
                  {member.role === "owner" ? (
                    <span className="text-xs text-muted-foreground">Owner</span>
                  ) : data.canManage ? (
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => run(() => lpApi.unshareProject(projectId, member.user.userId))}
                    >
                      Remove
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Member</span>
                  )}
                </li>
              ))}
              {data?.invites.map((invite) => (
                <li
                  key={invite.inviteId}
                  className="flex flex-col gap-1 py-2"
                  data-testid="lp-share-pending"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">
                      {invite.email}
                    </div>
                    <Badge variant="outline" data-lp-dot="ring">
                      Invited, pending
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      Invite open until {shortDate(invite.expiresAt)}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="lp-share-pending-copy"
                      onClick={() => copy(lpAbsoluteUrl(invite.path), "Invite link copied")}
                    >
                      <CopyIcon />
                      Copy link
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="lp-share-pending-resend"
                      onClick={() =>
                        run(() =>
                          shareApi.resend(projectId, invite.inviteId).then((result) =>
                            toastManager.add({
                              type: "success",
                              title: result.emailSent
                                ? `Sent again to ${invite.email}`
                                : "Invite renewed. Copy the link to send it.",
                            }),
                          ),
                        )
                      }
                    >
                      <SendIcon />
                      Resend
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      data-testid="lp-share-pending-revoke"
                      onClick={() => run(() => shareApi.revoke(projectId, invite.inviteId))}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {data?.canManage ? (
            <section
              className="flex flex-col gap-3 rounded-row border border-hairline p-3"
              aria-label="Share link"
              data-testid="lp-share-link"
            >
              <div className="flex items-center gap-3">
                <LinkIcon className="size-4 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium">Share link</h3>
                  <p className="text-xs text-muted-foreground">Anyone with the link can join</p>
                </div>
                <Switch
                  aria-label="Anyone with the link can join"
                  data-testid="lp-share-link-toggle"
                  checked={linkOn}
                  onCheckedChange={(enabled) => updateLink({ enabled })}
                />
              </div>
              {linkOn && linkUrl ? (
                <>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Share link"
                      className="flex-1"
                      readOnly
                      value={linkUrl}
                      data-testid="lp-share-link-url"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="lp-share-link-copy"
                      onClick={() => copy(linkUrl, "Link copied")}
                    >
                      <CopyIcon />
                      Copy
                    </Button>
                  </div>
                  <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
                    <span className="text-muted-foreground">Role</span>
                    <span>
                      Member{" "}
                      <span className="text-xs text-muted-foreground">
                        Projects only have owners and members.
                      </span>
                    </span>
                    <span className="text-muted-foreground">Expires</span>
                    <div className="flex items-center gap-2">
                      <Select
                        value={link!.expiry}
                        onValueChange={(value) => {
                          if (value !== null && value !== link!.expiry) {
                            updateLink({ expiry: value as LpLinkExpiry });
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Link expiry" className="w-28" size="sm">
                          <SelectValue>{EXPIRY_LABEL[link!.expiry]}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="1d">1 day</SelectItem>
                          <SelectItem value="7d">7 days</SelectItem>
                          <SelectItem value="never">Never</SelectItem>
                        </SelectPopup>
                      </Select>
                      {link!.expiresAt ? (
                        <span className="text-xs text-muted-foreground">
                          until {shortDate(link!.expiresAt)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <form
                    className="flex flex-wrap items-center gap-2"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      updateLink({ domain: domain.trim() || null });
                    }}
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        aria-label="Only people with emails at a domain"
                        checked={domainOn}
                        onCheckedChange={(on) => {
                          setDomainOn(on);
                          if (!on && link!.domain !== null) updateLink({ domain: null });
                        }}
                      />
                      Only people with emails at
                    </label>
                    {domainOn ? (
                      <>
                        <Input
                          aria-label="Email domain"
                          className="w-40"
                          placeholder="acme.com"
                          value={domain}
                          onChange={(event) => setDomain(event.target.value)}
                          data-testid="lp-share-link-domain"
                        />
                        <Button size="xs" variant="outline" type="submit">
                          Save
                        </Button>
                      </>
                    ) : null}
                  </form>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="lp-share-link-reset"
                      onClick={() =>
                        run(
                          () =>
                            shareApi.resetLink(projectId).then(() =>
                              toastManager.add({
                                type: "success",
                                title: "New link made. The old one no longer works.",
                              }),
                            ),
                          setLinkHint,
                        )
                      }
                    >
                      <RotateCcwIcon />
                      Reset link
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Makes a new link. The old one stops working.
                    </span>
                  </div>
                </>
              ) : null}
              {linkHint ? <Hint>{linkHint}</Hint> : null}
              {data.joins.length > 0 ? (
                <div className="flex flex-col gap-1" data-testid="lp-share-link-joins">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Joined with the link
                  </h4>
                  <ul className="flex flex-col gap-1">
                    {data.joins.map((join) => (
                      <li key={join.user.userId} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {join.user.displayName}{" "}
                          <span className="text-xs text-muted-foreground">{join.user.email}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {shortDate(join.joinedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </DialogPanel>
    </>
  );
}
