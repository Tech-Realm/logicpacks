import { describe, expect, it } from "vite-plus/test";

import {
  ACHIEVEMENT_SHELVES,
  ACHIEVEMENTS,
  describeAchievements,
  EMPTY_METRICS,
  levelForPoints,
  pointsFor,
  reachedAchievementIds,
} from "./achievements.ts";

describe("achievements", () => {
  it("has unique ids on known shelves, each reachable by one metric", () => {
    const ids = ACHIEVEMENTS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    const shelves = new Set(ACHIEVEMENT_SHELVES.map((shelf) => shelf.id));
    for (const definition of ACHIEVEMENTS) {
      expect(shelves.has(definition.shelf)).toBe(true);
      expect(definition.threshold).toBeGreaterThan(0);
      expect(definition.description).not.toMatch(/—/);
    }
  });

  it("covers the LogicPacks collaboration events", () => {
    const reached = reachedAchievementIds({
      ...EMPTY_METRICS,
      projectsSynced: 1,
      inviteesJoined: 1,
      conflictsResolved: 1,
      threadsShared: 1,
      longestStreakDays: 7,
      agentHours: 10,
      helperSessionsLinked: 1,
    });
    for (const id of [
      "first_sync",
      "first_invite_accepted",
      "peacemaker",
      "in_the_open",
      "week_streak",
      "ten_hours_back",
      "helper_linked",
    ]) {
      expect(reached).toContain(id);
    }
    expect(reachedAchievementIds(EMPTY_METRICS)).toEqual([]);
  });

  it("reports progress and keeps a stored unlock even when the count drops", () => {
    const shelf = describeAchievements(
      { ...EMPTY_METRICS, turns: 50 },
      new Map([["open_door", "2026-10-30T00:00:00.000Z"]]),
    );
    const hundred = shelf.find((achievement) => achievement.id === "hundred_turns")!;
    expect(hundred.progress).toBe(0.5);
    expect(hundred.unlocked).toBe(false);
    const openDoor = shelf.find((achievement) => achievement.id === "open_door")!;
    expect(openDoor.unlocked).toBe(true);
    expect(openDoor.progress).toBe(1);
  });

  it("levels up on a square curve", () => {
    expect(levelForPoints(0)).toEqual({ level: 1, nextLevelPoints: 10, levelProgress: 0 });
    expect(levelForPoints(10).level).toBe(2);
    expect(levelForPoints(39).level).toBe(2);
    expect(levelForPoints(40).level).toBe(3);
    expect(pointsFor(["first_turn", "first_sync", "unknown"])).toBe(13);
  });

});
