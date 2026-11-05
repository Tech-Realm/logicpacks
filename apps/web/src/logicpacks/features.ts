import { useEffect } from "react";
import { create } from "zustand";

import { lpRequest } from "./api";

/**
 * Feature access (web side). The core workspace is open to everyone; gated features (talent, apps, the freelancer jobs board) show only for accounts that have them. Gated UI is
 * simply absent otherwise: no locked teasers.
 *
 *   const canUseApps = useFeature("apps");
 *   if (!canUseApps) return null;
 */

export type LpFeature = "talent" | "apps" | "freelancer_jobs" | "cloud" | "cloud_agents";

export interface LpFeatureState {
  readonly loaded: boolean;
  readonly signedIn: boolean;
  readonly staff: boolean;
  readonly features: ReadonlyArray<LpFeature>;
  /** This server is the LogicPacks cloud (app.logicpacks.io). */
  readonly cloudHost: boolean;
  /** On the cloud: whether the caller may use the cloud workspace; else it is "coming soon". */
  readonly cloudAccess: boolean;
  /** Whether the caller can enter an access code here (a laptop's owner, anyone on the cloud). */
  readonly canRedeem: boolean;
}

const useFeatureStore = create<LpFeatureState>(() => ({
  loaded: false,
  signedIn: false,
  staff: false,
  features: [],
  cloudHost: false,
  cloudAccess: true,
  canRedeem: false,
}));

let inflight: Promise<void> | null = null;

/** Reads the caller's features again (after redeeming a code, signing in or out). */
export function refreshFeatures(): Promise<void> {
  inflight ??= lpRequest<Omit<LpFeatureState, "loaded">>("/api/lp/features")
    .then((state) =>
      useFeatureStore.setState({
        loaded: true,
        signedIn: state.signedIn,
        staff: state.staff,
        features: state.features,
        cloudHost: state.cloudHost === true,
        cloudAccess: state.cloudAccess !== false,
        canRedeem: state.canRedeem === true,
      }),
    )
    // A server without feature access (or offline): nothing gated shows.
    .catch(() => useFeatureStore.setState({ loaded: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** All of the caller's features; loads them once per page. */
export function useFeatures(): LpFeatureState {
  const state = useFeatureStore();
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- one read of the server's feature list for this session
  useEffect(() => {
    if (!state.loaded) void refreshFeatures();
  }, [state.loaded]);
  return state;
}

/** Whether the signed-in account may use a gated feature. False until known. */
export function useFeature(feature: LpFeature): boolean {
  return useFeatures().features.includes(feature);
}

export const featuresApi = {
  redeem: (code: string) =>
    lpRequest<{ unlocked: ReadonlyArray<LpFeature>; features: ReadonlyArray<LpFeature> }>(
      "/api/lp/features/redeem",
      { code },
    ).then(async (result) => {
      await refreshFeatures();
      return result;
    }),
};

const cloudSyncLockedOf = (state: LpFeatureState) =>
  !state.cloudHost && !state.features.includes("cloud");

/**
 * A laptop or desktop host without the cloud feature: syncing to the LogicPacks cloud shows
 * only as a quiet "Cloud sync: coming soon" label. Locked until the features are known.
 */
export function useCloudSyncLocked(): boolean {
  return cloudSyncLockedOf(useFeatures());
}

/** The same, outside React (context menus). */
export function readCloudSyncLocked(): boolean {
  return cloudSyncLockedOf(useFeatureStore.getState());
}
