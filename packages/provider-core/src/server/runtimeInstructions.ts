const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** LogicPacks: the server keeps synced checkouts current; agents only rebase their own worktrees. */
export const LOGICPACKS_COLLABORATION_INSTRUCTIONS = `<logicpacks_collaboration>
A LogicPacks project is synced when its repository has a committed .logicpacks/sync.json; its "agents" field is that project's standing instruction for you. In a synced project teammates and their agents push to the same remote from their machines and from the LogicPacks cloud host. LogicPacks itself saves, pulls and pushes the project's main checkout between turns, on every computer and on the cloud host, so never start your own sync loop, monitor or cron for it. Only in a separate git worktree or branch: fetch and rebase onto its upstream (merge when the branch is already pushed) before you push, and push your commits once the tree is clean. Never discard anyone's work. Resolve a conflict yourself only when both sides' intent is clear; otherwise tell the user which files conflict and who changed them. In a project that is not synced, never push on your own; tell the user once that teammates cannot see it until they press Sync. When the user asks to sync the project to the cloud, LogicPacks starts the sync from that message itself: do not create remotes or push for it, just say the project badge shows Syncing and then Synced.
</logicpacks_collaboration>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in LogicPacks through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in LogicPacks' files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${LOGICPACKS_COLLABORATION_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
