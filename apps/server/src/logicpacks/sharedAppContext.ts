/**
 * The shared-app block of an agent's turn: while the host shares an app in the
 * thread's project, the agent gets that app's recipe (how to work in it with
 * `lp app run`). The app-sharing hub registers the lookup, so the ledger does
 * not depend on the HTTP layer.
 */
let lookup: ((projectId: string) => string) | null = null;

export function registerSharedAppContext(fn: (projectId: string) => string) {
  lookup = fn;
}

export function sharedAppContextFor(projectId: string): string {
  return lookup?.(projectId) ?? "";
}
