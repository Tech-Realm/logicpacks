import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { PresenceEntry, PresenceLocation } from "@logicpacks/contracts";
import { ProjectId } from "@logicpacks/contracts";

import "~/index.css";
import { render } from "../../test/render";
import type { LpProjectRecipe, LpRecipeView } from "./api";
import { RecipeAppPanel } from "./RecipeAppPanel";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const mocks = vi.hoisted(() => ({
  recipes: new Map<string, LpProjectRecipe>(),
  views: new Map<string, LpRecipeView>(),
  launched: [] as string[],
  presence: [] as PresenceEntry[],
  reported: [] as Array<PresenceLocation | null>,
}));

// Presence rides the server socket in the app; here the panel gets the entries directly
// and what it would report is recorded.
vi.mock("./AppPresence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AppPresence")>()),
  useAppPresence: (input: { location: PresenceLocation | null }) => {
    mocks.reported.push(input.location);
    return mocks.presence;
  },
}));

// The live app view only runs in the desktop app.
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isElectron: true,
}));
vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    lpApi: {
      ...original.lpApi,
      projectRecipe: async (projectId: string) => mocks.recipes.get(projectId)!,
      recipeView: async (projectId: string) => mocks.views.get(projectId) ?? { running: false },
      launchRecipe: async (projectId: string) => {
        mocks.launched.push(projectId);
        return { running: true, alreadyRunning: false };
      },
    },
  };
});

const blender = (
  access: NonNullable<LpProjectRecipe["app"]>["access"],
  running: boolean,
): LpProjectRecipe => ({
  recipeId: "blender",
  app: { name: "Blender", download: null, access, installed: true, running },
});

// Fixed past edits: ages depend on the clock, so the assertions below leave them out.
const EARLIER = "2026-10-31T11:57:00.000Z";
const LATER = "2026-10-31T11:59:00.000Z";

describe("RecipeAppPanel", () => {
  it("shows the app's frame beside the scene outline, crediting who changed what", async () => {
    mocks.recipes.set("p-live", blender("open", true));
    mocks.views.set("p-live", {
      running: true,
      file: "/work/robot/scene.blend",
      background: false,
      ops: 4,
      mode: "viewport",
      image: PIXEL,
      objects: [
        {
          id: "car",
          name: "Car",
          type: "MESH",
          parent: null,
          hidden: false,
          last: { actor: { kind: "human", id: "local" }, at: EARLIER, kind: "object.set" },
        },
        {
          id: "wheel",
          name: "Wheel",
          type: "MESH",
          parent: "car",
          hidden: false,
          last: {
            actor: { kind: "agent", id: "a1", name: "Ali's agent" },
            at: LATER,
            kind: "object.add",
          },
        },
        { id: "cam", name: "Camera", type: "CAMERA", parent: null, hidden: false, last: null },
      ],
    });
    await using screen = await render(
      <div style={{ width: 900, height: 600 }}>
        <RecipeAppPanel projectId="p-live" title="Blender" visible />
      </div>,
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid=lp-app-frame]")).not.toBeNull(),
    );
    const frame = document.querySelector<HTMLImageElement>("[data-testid=lp-app-frame]")!;
    expect(frame.dataset.mode).toBe("viewport");
    expect(frame.src.startsWith("data:image/png;base64,")).toBe(true);
    const rows = [...document.querySelectorAll("[data-testid=lp-app-outline-item]")].map(
      (row) => row.textContent,
    );
    expect(rows.map((row) => row?.replace(/\d+[smhd]$|now$/, ""))).toEqual([
      "Camera",
      "CarY",
      "WheelA",
    ]);
    await expect.element(screen.getByText("Live from your viewport")).toBeVisible();
    await expect.element(screen.getByText("4 edits logged")).toBeVisible();
    const activity = [...document.querySelectorAll("[data-testid=lp-app-activity]")].map(
      (entry) => entry.textContent,
    );
    expect(activity.map((entry) => entry?.replace(/ (\d+[smhd]|now)$/, ""))).toEqual([
      "Ali's agent added Wheel",
      "You changed Car",
    ]);
  });

  it("offers to open the app when it is not running", async () => {
    mocks.recipes.set("p-closed", blender("open", false));
    await using screen = await render(
      <RecipeAppPanel projectId="p-closed" title="Blender" visible />,
    );
    const open = screen.getByTestId("lp-app-open");
    await expect.element(open).toBeVisible();
    await expect.element(screen.getByText("Blender is not open")).toBeVisible();
    await userEvent.click(open);
    await vi.waitFor(() => expect(mocks.launched).toContain("p-closed"));
  });

  it("points people who cannot run the app here to the desktop app", async () => {
    mocks.recipes.set("p-member", blender("open-in-desktop", false));
    await using screen = await render(
      <RecipeAppPanel projectId="p-member" title="Blender" visible />,
    );
    await expect.element(screen.getByTestId("lp-app-desktop-only")).toBeVisible();
    await expect.element(screen.getByText("Blender runs in the desktop app")).toBeVisible();
  });

  it("shows who is on which object, live, and shares this person's spot", async () => {
    const at = LATER;
    const presenceEntry = (
      key: string,
      actor: PresenceEntry["actor"],
      location: PresenceLocation,
    ): PresenceEntry => ({
      key,
      clientId: key,
      projectId: ProjectId.make("p-presence"),
      actor,
      source: actor.kind === "agent" ? "server" : "web",
      location,
      since: at,
      updatedAt: at,
    });
    mocks.presence = [
      presenceEntry(
        "noor",
        { id: "lp-user:noor", kind: "human", name: "Noor", colorIndex: 2 },
        {
          view: "app",
          activity: "viewing",
          appItem: { recipeId: "blender", itemId: "car", label: "Car" },
          pointer: { x: 0.5, y: 0.25 },
        },
      ),
      presenceEntry(
        "agent:thread:t1",
        { id: "lp-user:ali:agent", kind: "agent", name: "Ali's agent", colorIndex: 5 },
        // Agents name a fresh object by its name until Blender gives it an id.
        { view: "app", activity: "editing", appItem: { recipeId: "blender", itemId: "Wheel" } },
      ),
    ];
    mocks.reported = [];
    mocks.recipes.set("p-presence", blender("open", true));
    mocks.views.set("p-presence", {
      running: true,
      file: "/work/robot/scene.blend",
      background: false,
      ops: 1,
      mode: "viewport",
      image: PIXEL,
      objects: [
        { id: "car", name: "Car", type: "MESH", parent: null, hidden: false, last: null },
        { id: "w1", name: "Wheel", type: "MESH", parent: "car", hidden: false, last: null },
        { id: "cam", name: "Camera", type: "CAMERA", parent: null, hidden: false, last: null },
      ],
    });
    await using screen = await render(
      <div style={{ width: 900, height: 600 }}>
        <RecipeAppPanel projectId="p-presence" title="Blender" visible />
      </div>,
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid=lp-app-frame]")).not.toBeNull(),
    );
    const row = (name: string) =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=lp-app-outline-item]")].find(
        (item) => item.querySelector("button")?.textContent === name,
      )!;
    const avatarsOn = (name: string) =>
      [...row(name).querySelectorAll<HTMLElement>("[data-presence-actor]")].map(
        (avatar) => avatar.dataset.presenceActor,
      );
    expect(avatarsOn("Car")).toEqual(["lp-user:noor"]);
    expect(avatarsOn("Wheel")).toEqual(["lp-user:ali:agent"]);
    expect(avatarsOn("Camera")).toEqual([]);
    // Noor's pointer over the live view, named, with what she is on; the agent's flag.
    const cursor = document.querySelector<HTMLElement>("[data-app-cursor=Noor]")!;
    expect(cursor.style.left).toBe("50%");
    expect(cursor.style.top).toBe("25%");
    expect(cursor.textContent).toContain("Noor · Car");
    expect(document.querySelector("[data-app-agent]")?.textContent).toBe(
      "Ali's agent editing Wheel",
    );
    // This person is in the app; picking an object in the outline puts them on it.
    await vi.waitFor(() =>
      expect(mocks.reported.at(-1)).toEqual({ view: "app", activity: "viewing" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Camera" }));
    await vi.waitFor(() =>
      expect(mocks.reported.at(-1)).toEqual({
        view: "app",
        activity: "viewing",
        appItem: { recipeId: "blender", itemId: "cam", label: "Camera" },
      }),
    );
    expect(row("Camera").dataset.selected).toBe("true");
    // Moving over the live view shares the pointer as fractions of the view.
    await userEvent.hover(screen.getByTestId("lp-app-view"));
    await vi.waitFor(() => expect(mocks.reported.at(-1)?.pointer).toBeDefined());
    const shared = mocks.reported.at(-1)!.pointer!;
    expect(shared.x).toBeGreaterThan(0);
    expect(shared.x).toBeLessThanOrEqual(1);
  });

  it("reports nothing while the app is not on screen", async () => {
    mocks.presence = [];
    mocks.reported = [];
    mocks.recipes.set("p-hidden", blender("open", true));
    mocks.views.set("p-hidden", { running: false });
    await using screen = await render(
      <RecipeAppPanel projectId="p-hidden" title="Blender" visible={false} />,
    );
    await vi.waitFor(() => expect(mocks.reported.length).toBeGreaterThan(0));
    expect(mocks.reported.every((location) => location === null)).toBe(true);
    void screen;
  });
});
