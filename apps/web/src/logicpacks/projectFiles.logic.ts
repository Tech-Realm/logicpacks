import { promptLinkDeepLink } from "@logicpacks/shared/promptLinks";

/** What the host says about getting one project onto a computer (GET /api/lp/projects/local). */
export interface LpProjectLocal {
  readonly projectId: string;
  readonly title: string;
  readonly synced: boolean;
  readonly cloneUrl: string | null;
  readonly githubRepo: string | null;
  readonly branch: string | null;
  readonly cloudHost: boolean;
  readonly syncSeconds: number;
  readonly uploadMaxBytes: number;
}

/** The prompt LogicPacks for Mac drafts after it clones the project (the person sends it). */
export const OPEN_ON_MAC_PROMPT =
  "I just cloned this project from the LogicPacks cloud. Give me a short tour of what is here and what changed recently.";

/**
 * Opens LogicPacks for Mac on the project: the desktop app's existing /new link finds the
 * project by its GitHub repository, or offers to clone it, then drafts a first prompt.
 */
export function buildOpenOnMacLink(githubRepo: string, scheme = "logicpacks"): string | null {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(githubRepo.trim());
  if (!match) return null;
  const params = new URLSearchParams({
    prompt: OPEN_ON_MAC_PROMPT,
    repo: `${match[1]}/${match[2]}`,
  });
  return promptLinkDeepLink(`/new?${params.toString()}`, scheme);
}

/** "within 2 minutes", "within 20 seconds": how soon a push shows up on the host. */
export function syncDelayText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "after the next sync";
  if (seconds < 60) return `within ${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `within ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The terminal lines for someone using their own agent. */
export function cloneCommands(local: Pick<LpProjectLocal, "title" | "cloneUrl" | "githubRepo">) {
  const name = local.githubRepo ?? local.title;
  return {
    lpClone: `lp clone ${/^[A-Za-z0-9._/-]+$/.test(name) ? name : JSON.stringify(name)}`,
    gitClone: local.cloneUrl === null ? null : `git clone ${local.cloneUrl}`,
  };
}

/** One file picked or dropped, with the path it keeps inside the chosen folder. */
export interface UploadItem {
  readonly file: File;
  readonly path: string;
}

/** Joins the chosen folder and a relative path, without leading or doubled slashes. */
export function joinUploadPath(folder: string, path: string): string {
  return [folder, path]
    .flatMap((part) => part.replaceAll("\\", "/").split("/"))
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/** The upload request's query string. */
export function uploadQuery(input: {
  readonly projectId: string;
  readonly folder: string;
  readonly path: string;
  readonly conflict: "fail" | "replace" | "keep-both";
}): string {
  return new URLSearchParams({
    projectId: input.projectId,
    folder: input.folder,
    path: input.path,
    conflict: input.conflict,
  }).toString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every file in a drop, folders walked, each with its path relative to what was dropped. */
export async function filesFromDataTransfer(transfer: DataTransfer): Promise<Array<UploadItem>> {
  const entries = Array.from(transfer.items ?? [])
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined);
  if (entries.length === 0) {
    return Array.from(transfer.files ?? []).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
  }
  const items: Array<UploadItem> = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      items.push({ file, path: `${prefix}${entry.name}` });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<Array<FileSystemEntry>>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return items;
}

/** Files from an <input type=file>, keeping folder structure when a folder was picked. */
export function filesFromInput(list: FileList | null): Array<UploadItem> {
  return Array.from(list ?? []).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

/** A drag that carries files from the computer (not a tree row or text being moved). */
export function isExternalFileDrag(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types ?? []).includes("Files");
}
