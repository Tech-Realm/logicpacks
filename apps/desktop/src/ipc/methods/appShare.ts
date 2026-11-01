import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  appSharePermissions,
  armKillSwitch,
  injectInput,
  listShareableWindows,
  releaseHeldInput,
  requestAccessibility,
} from "../../appShare/AppShareHost.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const notifyKill = () => {
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.APP_SHARE_KILL_CHANNEL);
  }
};

export const listWindows = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APP_SHARE_LIST_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.appShare.list")(function* () {
    return yield* Effect.promise(() => listShareableWindows());
  }),
});

const InjectPayload = Schema.Struct({ windowId: Schema.Number, ev: Schema.Unknown });

export const inject = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APP_SHARE_INJECT_CHANNEL,
  payload: InjectPayload,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.appShare.inject")(function* ({ windowId, ev }) {
    return yield* Effect.promise(() => injectInput(windowId, ev));
  }),
});

export const permissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APP_SHARE_PERMISSIONS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.appShare.permissions")(function* () {
    return yield* Effect.promise(() => appSharePermissions());
  }),
});

export const askAccessibility = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APP_SHARE_REQUEST_ACCESSIBILITY_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appShare.askAccessibility")(function* () {
    return requestAccessibility();
  }),
});

/** Arms the global kill hotkey while sharing; disarming also lets go of held buttons. */
export const arm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APP_SHARE_ARM_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appShare.arm")(function* (armed) {
    if (!armed) yield* Effect.promise(() => releaseHeldInput());
    return armKillSwitch(armed, notifyKill);
  }),
});
