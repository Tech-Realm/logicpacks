import type { EnvironmentId } from "@logicpacks/contracts";
import { useCloudSyncLocked } from "./features";
import {
  CloudUploadIcon,
  CopyIcon,
  DownloadIcon,
  FileArchiveIcon,
  FolderUpIcon,
  LaptopIcon,
  TerminalIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { DESKTOP_DOWNLOAD_URL } from "../branding";
import { Button } from "../components/ui/button";
import { DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../state/environments";
import { lpAbsoluteUrl, lpApi, lpRequestAuth } from "./api";
import {
  buildOpenOnMacLink,
  cloneCommands,
  filesFromDataTransfer,
  filesFromInput,
  formatBytes,
  isExternalFileDrag,
  joinUploadPath,
  type LpProjectLocal,
  type UploadItem,
  syncDelayText,
  uploadQuery,
} from "./projectFiles.logic";
import { closeLpDialog, openLpDialog, useLogicPacksSession } from "./store";
import { applySyncStatus, useCloudHost, useProjectSync } from "./sync";
import { startProjectSync } from "./SyncControls";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Fired after files land in a project, so open file trees list them. */
export const LP_FILES_CHANGED_EVENT = "lp:project-files-changed";

/** Files in and out of the web app make sense where the project lives on the host, not on a laptop. */
export function useLpProjectFilesAvailable(environmentId: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const cloud = useCloudHost();
  return (
    session !== null &&
    environmentId !== null &&
    environmentId === primaryEnvironmentId &&
    (cloud?.isCloudHost === true || session.cloudHost === true)
  );
}

/** "Get it on your computer" and "Upload files", next to Share in the chat header. */
export function LpProjectFilesButtons({
  projectId,
  environmentId,
  title,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  if (!useLpProjectFilesAvailable(environmentId)) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              data-testid="lp-upload-open"
              aria-label={`Upload files to ${title}`}
              onClick={(event) => {
                event.stopPropagation();
                openLpDialog({ kind: "upload-files", projectId, title, folder: "" });
              }}
            />
          }
        >
          <UploadIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Upload files from your computer</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              data-testid="lp-get-local-open"
              aria-label={`Get ${title} on your computer`}
              onClick={(event) => {
                event.stopPropagation();
                openLpDialog({ kind: "get-local", projectId, title });
              }}
            />
          }
        >
          <LaptopIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Get it on your computer</TooltipPopup>
      </Tooltip>
    </>
  );
}

const copy = (text: string) =>
  void writeTextToClipboard(text)
    .then(() => toastManager.add({ type: "success", title: "Copied" }))
    .catch((error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: errorText(error) }),
    );

function CommandLine({ command, testId }: { command: string; testId: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-hairline bg-muted/40 py-1 ps-3 pe-1">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid={testId}>
        {command}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${command}`}
        onClick={() => copy(command)}
      >
        <CopyIcon aria-hidden />
      </Button>
    </div>
  );
}

/** Downloads the project's working copy as a zip with the same auth as the rest of the app. */
async function downloadZip(projectId: string, title: string) {
  const url = lpAbsoluteUrl(`/api/lp/projects/zip?projectId=${encodeURIComponent(projectId)}`);
  try {
    const auth = await lpRequestAuth(url);
    const response = await fetch(url, { credentials: auth.credentials, headers: auth.headers });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(payload.message ?? `The host answered ${response.status}.`);
    }
    const blob = await response.blob();
    const name =
      /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
      `${title}.zip`;
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  } catch (error) {
    toastManager.add({ type: "error", title: "Could not download", description: errorText(error) });
  }
}

/**
 * Opens LogicPacks for Mac through its link. When nothing takes the link (the app is not
 * installed), the page stays in front and the download page opens instead.
 */
function openOnMac(link: string) {
  let left = false;
  const onBlur = () => {
    left = true;
  };
  window.addEventListener("blur", onBlur, { once: true });
  window.location.href = link;
  setTimeout(() => {
    window.removeEventListener("blur", onBlur);
    if (!left && document.visibilityState === "visible") {
      window.open(DESKTOP_DOWNLOAD_URL, "_blank", "noopener");
    }
  }, 1500);
}

/** How to get one project onto a computer: the Mac app, your own agent, or a zip. */
export function GetLocalDialog({ projectId, title }: { projectId: string; title: string }) {
  const status = useProjectSync(projectId);
  // Reloads when sync finishes, so "Make it synced" turns into the clone options.
  return (
    <GetLocalBody
      key={`${status?.state ?? ""}:${status?.remoteUrl ?? ""}`}
      projectId={projectId}
      title={title}
      syncing={status?.state === "syncing"}
    />
  );
}

function GetLocalBody({
  projectId,
  title,
  syncing,
}: {
  projectId: string;
  title: string;
  syncing: boolean;
}) {
  const [local, setLocal] = useState<LpProjectLocal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloudLocked = useCloudSyncLocked();
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the project's clone details from the server once per sync state
  useEffect(() => {
    let cancelled = false;
    lpApi
      .projectLocal(projectId)
      .then((next) => {
        if (!cancelled) setLocal(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const commands = local ? cloneCommands(local) : null;
  const macLink = local?.githubRepo ? buildOpenOnMacLink(local.githubRepo) : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Get {title} on your computer</DialogTitle>
        <DialogDescription>
          {local === null
            ? "Checking where this project lives."
            : local.synced
              ? `It lives ${local.githubRepo ? "on GitHub" : "in its repository"} and here. Changes you push from your computer show up here ${syncDelayText(local.syncSeconds)}, and work done here is pushed back the same way.`
              : "It only lives on this host so far. Download a copy, or make it synced to work on it from your computer and keep both sides in step."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5 text-sm" data-testid="lp-get-local">
          {error ? (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {local && !local.synced && !cloudLocked ? (
            <section className="flex flex-col gap-2">
              <h3 className="font-medium">Make it synced</h3>
              <p className="text-muted-foreground">
                Puts it in a private GitHub repository. Then clone it on your computer, and Sync
                keeps both sides in step.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={syncing}
                data-testid="lp-get-local-sync"
                onClick={() => void startProjectSync(projectId, title)}
              >
                <CloudUploadIcon aria-hidden />
                {syncing ? "Syncing" : "Make it synced"}
              </Button>
            </section>
          ) : null}
          {local?.synced && macLink ? (
            <section className="flex flex-col gap-2">
              <h3 className="font-medium">LogicPacks for Mac</h3>
              <p className="text-muted-foreground">
                Opens the app, clones the project and keeps it synced. No app yet? This opens the
                download page. You can also choose Add project, then Git URL, in the app.
              </p>
              <Button
                size="sm"
                className="self-start"
                data-testid="lp-open-on-mac"
                data-href={macLink}
                onClick={() => openOnMac(macLink)}
              >
                <LaptopIcon aria-hidden />
                Open in LogicPacks for Mac
              </Button>
            </section>
          ) : null}
          {local?.synced && commands ? (
            <section className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 font-medium">
                <TerminalIcon aria-hidden className="size-4" />
                Your own agent or terminal
              </h3>
              <p className="text-muted-foreground">
                With the LogicPacks helper, this clones it and links it so your agent sessions show
                up for the team:
              </p>
              <CommandLine command={commands.lpClone} testId="lp-clone-command" />
              {commands.gitClone ? (
                <>
                  <p className="text-muted-foreground">
                    Or plain git, if your GitHub account can see the repository:
                  </p>
                  <CommandLine command={commands.gitClone} testId="lp-git-clone-command" />
                </>
              ) : null}
            </section>
          ) : null}
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Download a zip</h3>
            <p className="text-muted-foreground">
              A copy of the files as they are right now. It does not stay in sync.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              data-testid="lp-download-zip"
              onClick={() => void downloadZip(projectId, title)}
            >
              <FileArchiveIcon aria-hidden />
              Download zip
            </Button>
          </section>
        </div>
      </DialogPanel>
    </>
  );
}

type Conflict = "ask" | "replace" | "keep-both";

interface Row {
  readonly id: string;
  path: string;
  readonly size: number;
  state: "waiting" | "uploading" | "done" | "skipped" | "failed";
  progress: number;
  note: string | null;
}

/** One file: the body is its bytes. Resolves with the HTTP status and the JSON answer. */
async function sendFile(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = await lpRequestAuth(url);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.withCredentials = auth.credentials === "include";
    for (const [name, value] of Object.entries(auth.headers)) request.setRequestHeader(name, value);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / Math.max(1, event.total));
    };
    request.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {}
      resolve({ status: request.status, body });
    };
    request.onerror = () => reject(new Error("The upload was cut off."));
    request.send(file);
  });
}

/** Uploads into a folder of the project's working copy, then lets Sync commit and push it. */
export function UploadFilesDialog({
  projectId,
  title,
  folder: initialFolder,
  items: initialItems,
}: {
  projectId: string;
  title: string;
  folder: string;
  items?: ReadonlyArray<UploadItem> | undefined;
}) {
  const [folder, setFolder] = useState(initialFolder);
  const [items, setItems] = useState<ReadonlyArray<UploadItem>>(initialItems ?? []);
  const [conflict, setConflict] = useState<Conflict>("ask");
  const [rows, setRows] = useState<ReadonlyArray<Row>>([]);
  const [running, setRunning] = useState(false);
  const [question, setQuestion] = useState<{
    path: string;
    answer: (choice: "replace" | "keep-both" | "skip", forAll: boolean) => void;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const status = useProjectSync(projectId);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the host's upload size limit once
  useEffect(() => {
    lpApi
      .projectLocal(projectId)
      .then((local) => setMaxBytes(local.uploadMaxBytes))
      .catch(() => undefined);
  }, [projectId]);

  const add = (next: ReadonlyArray<UploadItem>) => {
    setRows([]);
    setItems((current) => [...current, ...next]);
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    add(await filesFromDataTransfer(event.dataTransfer));
  };

  const upload = async () => {
    if (items.length === 0 || running) return;
    setRunning(true);
    const table: Array<Row> = items.map((item, index) => ({
      id: `${index}:${item.path}`,
      path: joinUploadPath(folder, item.path),
      size: item.file.size,
      state: "waiting",
      progress: 0,
      note: null,
    }));
    const render = () => setRows(table.map((row) => ({ ...row })));
    render();
    let standing: Conflict = conflict;
    let written = 0;
    for (const [index, item] of items.entries()) {
      const row = table[index]!;
      if (maxBytes !== null && item.file.size > maxBytes) {
        row.state = "failed";
        row.note = `Over the ${formatBytes(maxBytes)} limit`;
        render();
        continue;
      }
      let mode: "fail" | "replace" | "keep-both" = standing === "ask" ? "fail" : standing;
      for (;;) {
        row.state = "uploading";
        render();
        const url = lpAbsoluteUrl(
          `/api/lp/projects/upload?${uploadQuery({ projectId, folder, path: item.path, conflict: mode })}`,
        );
        const result = await sendFile(url, item.file, (fraction) => {
          row.progress = fraction;
          render();
        }).catch((error: unknown): { status: number; body: Record<string, unknown> } => ({
          status: 0,
          body: { message: errorText(error) },
        }));
        if (result.status === 409 && result.body.error === "exists" && mode === "fail") {
          const choice = await new Promise<{
            choice: "replace" | "keep-both" | "skip";
            forAll: boolean;
          }>((resolve) =>
            setQuestion({
              path: row.path,
              answer: (choice, forAll) => resolve({ choice, forAll }),
            }),
          );
          setQuestion(null);
          if (choice.forAll) standing = choice.choice === "skip" ? "ask" : choice.choice;
          if (choice.choice === "skip") {
            row.state = "skipped";
            row.note = "Kept the existing file";
            break;
          }
          mode = choice.choice;
          continue;
        }
        if (result.status >= 200 && result.status < 300) {
          row.state = "done";
          row.progress = 1;
          row.path = String(result.body.path ?? row.path);
          row.note =
            result.body.status === "replaced"
              ? "Replaced"
              : result.body.status === "renamed"
                ? "Kept both"
                : null;
          written += 1;
        } else {
          row.state = "failed";
          row.note = String(result.body.message ?? `The host answered ${result.status}.`);
        }
        break;
      }
      render();
    }
    setRunning(false);
    setItems([]);
    if (written > 0) {
      window.dispatchEvent(new CustomEvent(LP_FILES_CHANGED_EVENT, { detail: { projectId } }));
      // Synced projects: commit and push now instead of on the next engine pass.
      if (status?.state === "synced") {
        lpApi
          .syncNow(projectId)
          .then((result) => applySyncStatus(result.status))
          .catch(() => undefined);
      }
      toastManager.add({
        type: "success",
        title: `Uploaded ${written} file${written === 1 ? "" : "s"} to ${title}`,
        description:
          status?.state === "synced"
            ? "Sync commits and pushes them, so teammates and agents see them."
            : "They are in the project now. Agents here can use them.",
      });
    }
  };

  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Upload to {title}</DialogTitle>
        <DialogDescription>
          Files go into the project on this host. Agents and teammates see them right away
          {status?.state === "synced" ? ", and Sync commits and pushes them" : ""}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3 text-sm" data-testid="lp-upload-dialog">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Folder in the project (empty for the top)</span>
            <Input
              aria-label="Upload folder"
              name="uploadFolder"
              placeholder="assets/images"
              value={folder}
              disabled={running}
              onChange={(event) => setFolder(event.target.value)}
            />
          </label>
          <div
            data-testid="lp-upload-dropzone"
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline px-4 py-6 text-center text-muted-foreground",
              dragging && "border-foreground/40 bg-muted/40",
            )}
            onDragOver={(event) => {
              if (!isExternalFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => void onDrop(event)}
          >
            <UploadIcon aria-hidden className="size-5" />
            <span>Drop files or folders here</span>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={running}
                onClick={() => filesInput.current?.click()}
              >
                <UploadIcon aria-hidden />
                Choose files
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={running}
                onClick={() => folderInput.current?.click()}
              >
                <FolderUpIcon aria-hidden />
                Choose a folder
              </Button>
            </div>
            <input
              ref={filesInput}
              type="file"
              multiple
              hidden
              data-testid="lp-upload-files-input"
              onChange={(event) => {
                add(filesFromInput(event.target.files));
                event.target.value = "";
              }}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              hidden
              data-testid="lp-upload-folder-input"
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(event) => {
                add(filesFromInput(event.target.files));
                event.target.value = "";
              }}
            />
            {maxBytes !== null ? (
              <span className="text-xs">Up to {formatBytes(maxBytes)} per file</span>
            ) : null}
          </div>
          <fieldset className="flex flex-wrap items-center gap-3" disabled={running}>
            <legend className="sr-only">When a file already exists</legend>
            <span className="text-muted-foreground">If a file exists:</span>
            {(
              [
                ["ask", "Ask me"],
                ["replace", "Replace"],
                ["keep-both", "Keep both"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="lp-upload-conflict"
                  value={value}
                  checked={conflict === value}
                  onChange={() => setConflict(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {question ? (
            <div
              role="alertdialog"
              aria-label="File exists"
              data-testid="lp-upload-conflict"
              className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3"
            >
              <p>
                <span className="font-mono text-xs">{question.path}</span> already exists.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={() => question.answer("replace", false)}>
                  Replace
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => question.answer("keep-both", false)}
                >
                  Keep both
                </Button>
                <Button size="xs" variant="ghost" onClick={() => question.answer("skip", false)}>
                  Skip
                </Button>
                <Button size="xs" variant="ghost" onClick={() => question.answer("replace", true)}>
                  Replace all
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => question.answer("keep-both", true)}
                >
                  Keep both for all
                </Button>
              </div>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto" data-testid="lp-upload-rows">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-0.5"
                  data-state={row.state}
                  data-path={row.path}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.path}</span>
                    <span
                      className={cn(
                        "text-xs",
                        row.state === "failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {row.note ??
                        (row.state === "uploading"
                          ? `${Math.round(row.progress * 100)}%`
                          : row.state === "done"
                            ? "Done"
                            : row.state === "waiting"
                              ? formatBytes(row.size)
                              : "")}
                    </span>
                  </div>
                  <div className="h-0.5 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-foreground/60 transition-[width]"
                      style={{ width: `${Math.round(row.progress * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground" data-testid="lp-upload-summary">
              {items.length > 0
                ? `${items.length} file${items.length === 1 ? "" : "s"}, ${formatBytes(totalBytes)}`
                : rows.length > 0 && !running
                  ? "Finished"
                  : "No files chosen"}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => closeLpDialog()} disabled={running}>
                Close
              </Button>
              <Button
                size="sm"
                data-testid="lp-upload-start"
                disabled={items.length === 0 || running}
                onClick={() => void upload()}
              >
                <DownloadIcon aria-hidden className="rotate-180" />
                {running ? "Uploading" : "Upload"}
              </Button>
            </div>
          </div>
        </div>
      </DialogPanel>
    </>
  );
}

/**
 * Drop target for a project's file tree: files dragged in from the computer open the upload
 * dialog with the drop already in it. Tree rows dragged inside the app are left alone.
 */
export function useLpFileTreeDrop(input: {
  readonly projectId: string | null;
  readonly title: string;
  readonly enabled: boolean;
}) {
  const [over, setOver] = useState(false);
  if (!input.enabled || input.projectId === null) {
    return { over: false, handlers: {} as Record<string, never> };
  }
  const projectId = input.projectId;
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!isExternalFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!isExternalFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void filesFromDataTransfer(event.dataTransfer).then((items) =>
          openLpDialog({ kind: "upload-files", projectId, title: input.title, folder: "", items }),
        );
      },
    },
  };
}
