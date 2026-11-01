import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { callHost } from "./client.ts";
import type { HelperConfig } from "./store.ts";

/** One project as the host lists it for `lp clone`. */
export interface HelperProject {
  readonly projectId: string;
  readonly title: string;
  /** The repository the host syncs with, or null while the project is not synced. */
  readonly cloneUrl: string | null;
  readonly githubRepo: string | null;
  readonly branch: string | null;
}

export interface HelperProjectList {
  readonly projects: ReadonlyArray<HelperProject>;
  readonly syncSeconds?: number;
}

/** Finds the project someone named: its id, `owner/name`, or its title (any case). */
export const pickProject = (
  projects: ReadonlyArray<HelperProject>,
  wanted: string,
): HelperProject | { readonly error: string } => {
  const needle = wanted.trim().toLowerCase();
  const exact = projects.filter(
    (project) =>
      project.projectId.toLowerCase() === needle ||
      project.githubRepo?.toLowerCase() === needle ||
      project.title.trim().toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    return {
      error: `More than one project is called "${wanted}". Use its id: ${exact.map((project) => project.projectId).join(", ")}`,
    };
  }
  const names = projects.map((project) => `  ${project.title}  (${project.projectId})`).join("\n");
  return {
    error: `No project "${wanted}" here.${names ? ` Your projects:\n${names}` : " No projects are shared with you yet."}`,
  };
};

/** The folder a clone lands in: the repository name, else the title, made path-safe. */
export const cloneFolderName = (project: HelperProject) => {
  const base = project.githubRepo?.split("/")[1] ?? project.title;
  return (
    base
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 80) || "project"
  );
};

/** "within 2 minutes", "within 20 seconds". */
export const syncDelayText = (seconds: number | undefined) => {
  if (!seconds || seconds <= 0) return "after the next sync";
  const minutes = Math.ceil(seconds / 60);
  return seconds < 60
    ? `within ${seconds} seconds`
    : `within ${minutes} minute${minutes === 1 ? "" : "s"}`;
};

/**
 * `lp clone <project> [folder]`: clones the project's repository (GitHub, or whatever remote
 * the host syncs with) and returns the folder. The helper then links it like `lp link`.
 * A project with no repository yet cannot be cloned: it is synced from the app first.
 */
export const cloneProject = async (input: {
  readonly config: HelperConfig;
  readonly wanted: string;
  readonly folder: string | null;
  readonly cwd: string;
  readonly say: (line: string) => void;
}): Promise<{
  readonly folder: string;
  readonly project: HelperProject;
  readonly syncSeconds?: number;
} | null> => {
  const list = await callHost<HelperProjectList>(input.config, "/api/lp/helper/projects");
  const picked = pickProject(list.projects, input.wanted);
  if ("error" in picked) {
    input.say(picked.error);
    return null;
  }
  if (picked.cloneUrl === null) {
    input.say(
      `"${picked.title}" is only on the host so far. Press Sync on it in LogicPacks to put it on GitHub, then run lp clone again. Or download a zip from the web app.`,
    );
    return null;
  }
  const folder = NodePath.resolve(input.cwd, input.folder ?? cloneFolderName(picked));
  if (NodeFS.existsSync(folder) && NodeFS.readdirSync(folder).length > 0) {
    input.say(
      `${folder} already exists and is not empty. Name another folder: lp clone ${input.wanted} <folder>`,
    );
    return null;
  }
  input.say(`Cloning ${picked.githubRepo ?? picked.cloneUrl} into ${folder}`);
  const cloned = NodeChildProcess.spawnSync(
    "git",
    ["clone", ...(picked.branch ? ["--branch", picked.branch] : []), picked.cloneUrl, folder],
    { stdio: "inherit" },
  );
  if (cloned.status !== 0) {
    input.say(
      picked.githubRepo
        ? `git clone failed. Ask the project owner to add your GitHub account to ${picked.githubRepo}, and check gh auth status.`
        : "git clone failed.",
    );
    return null;
  }
  return {
    folder,
    project: picked,
    ...(list.syncSeconds ? { syncSeconds: list.syncSeconds } : {}),
  };
};
