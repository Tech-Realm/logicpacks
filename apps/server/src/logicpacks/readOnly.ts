import * as Effect from "effect/Effect";

import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { json } from "./http.ts";

import { READ_ONLY_MESSAGE } from "./readOnlyMessage.ts";

export { READ_ONLY_MESSAGE };

export const readOnlyResponse = () => json({ error: "read_only", message: READ_ONLY_MESSAGE }, 403);

/**
 * A refusal response when the caller has a Read only seat where the change lands (the project's
 * workspace, or their current workspace when no project is named); otherwise null. The host
 * operator is never read only.
 */
export const refuseIfReadOnly = Effect.fn("logicpacks.refuseIfReadOnly")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  projectId: string | null,
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  return access.isReadOnly(caller.userId, projectId) ? readOnlyResponse() : null;
});
