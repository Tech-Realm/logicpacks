import { READ_ONLY_MESSAGE } from "./readOnlyMessage.ts";

export { READ_ONLY_MESSAGE };

/** Commands that only move the viewer's own place (unread marks), not the work. */
const VIEWER_COMMAND_TYPES: ReadonlySet<string> = new Set(["thread.visit", "thread.mark-unread"]);

/** Reads and harmless UI calls a Read only member keeps. */
const VIEWER_METHODS: ReadonlySet<string> = new Set([
  "orchestration.getTurnDiff",
  "orchestration.getFullThreadDiff",
  "orchestration.searchThreads",
  "orchestration.searchThread",
  "orchestration.searchThreadStream",
  "orchestration.getArchivedShellSnapshot",
  "orchestration.getThreadFamily",
  "orchestration.getWorktreeThreadIds",
  "orchestration.getOlderSettledThreads",
  "orchestration.getThreadProjection",
  "orchestration.getWorkflowScript",
  "orchestration.getTurnItem",
  "orchestration.subscribeShell",
  "orchestration.subscribeThread",
  "orchestration.subscribeCommandOutput",
  "projects.listEntries",
  "projects.listIgnoredFiles",
  "projects.readFile",
  "projects.searchContents",
  "projects.searchEntries",
  "filesystem.browse",
  "filesystem.getMetadata",
  "assets.createUrl",
  "mcpApps.toolInfo",
  "mcpApps.readResource",
  "vcs.refreshStatus",
  "vcs.listRefs",
  "review.getBranchCommits",
  "review.getDiffPreview",
  "review.getDiffFileContents",
  "preview.list",
  "preview.resize",
  "preview.adjust",
  "preview.close",
  "preview.reportProfiles",
  "preview.reportStatus",
  "device.list",
  "device.detail",
  "server.probe",
  "server.getConfig",
  "server.getNpmRelease",
  "server.refreshProviders",
  "server.getHostResources",
  "server.getUsageSummary",
  "server.reportClientActivity",
  "logicpacks.getLeaderboard",
  "logicpacks.getAchievements",
  "logicpacks.setUsageSharing",
  "logicpacks.reportActivity",
  "scheduledTasks.subscribe",
  "scheduledTasks.listWebhookDeliveries",
  "scheduledTasks.getWebhookDelivery",
  "cloud.getRelayClientStatus",
  "pullRequests.list",
  "pullRequests.listStats",
  "pullRequests.filterOptions",
  "pullRequests.summary",
  "pullRequests.routing",
  "pullRequests.routingIdentity",
  "pullRequests.stack",
  "pullRequests.linkedThreads",
  "pullRequests.detail",
  "pullRequests.preview",
  "pullRequests.checks",
  "pullRequests.activity",
  "pullRequests.reviewGuide",
  "pullRequests.threadComments",
  "pullRequests.diffFileContents",
  "pullRequests.filesViewed",
  "pullRequests.changeBreakdown",
  "pullRequests.subscribeRefreshes",
  "pullRequests.reviewerCandidates",
  "pullRequests.labelCandidates",
  "sourceControl.lookupRepository",
  "sourceControl.appAccess",
  "sourceControl.starred",
  "presence.update",
  "presence.subscribe",
]);

/**
 * Whether a Read only member may make this call. Everything is refused unless it is a read, a
 * stream, or a harmless view call, so a new mutating RPC is closed by default.
 */
export const viewerMayCall = (method: string, payload: unknown): boolean => {
  if (method.startsWith("subscribe")) return true;
  if (method === "orchestration.dispatchCommand") {
    const type =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)["type"]
        : undefined;
    return typeof type === "string" && VIEWER_COMMAND_TYPES.has(type);
  }
  return VIEWER_METHODS.has(method);
};
