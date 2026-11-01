import { PRESENCE_COLOR_COUNT, ProjectId, type PresenceEntry } from "@logicpacks/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";

import { createPresenceCaretElement, PresenceAvatarStack } from "./PresenceAvatarStack";
import { presenceColor } from "./presenceLogic";

const at = "2026-01-01T00:00:00.000Z";
const entry = (key: string, actor: PresenceEntry["actor"]): PresenceEntry => ({
  key,
  clientId: `${key}:file`,
  projectId: ProjectId.make("p"),
  actor,
  source: "web",
  location: { view: "file", activity: "editing", path: "src/a.ts", cursor: { line: 4, column: 0 } },
  since: at,
  updatedAt: at,
});

const ali = { id: "lp-user:ali", kind: "human" as const, name: "Ali Khan", colorIndex: 1 };
const aliAgent = { id: "agent:1", kind: "agent" as const, name: "Ali's agent", colorIndex: 1 };
const people = ["Noor", "Sara", "Omar", "Zain"].map((name, index) => ({
  id: `lp-user:${name}`,
  kind: "human" as const,
  name,
  colorIndex: index + 2,
}));

describe("PresenceAvatarStack", () => {
  it("shows one avatar per person, an overflow count, and the hover lines", async () => {
    await using screen = await render(
      <PresenceAvatarStack
        entries={[
          entry("a", ali),
          entry("b", ali),
          entry("c", aliAgent),
          ...people.map((actor, index) => entry(`p${index}`, actor)),
        ]}
      />,
      { router: false },
    );
    const avatars = screen.container.querySelectorAll("[data-presence-actor]");
    expect(Array.from(avatars, (avatar) => avatar.textContent)).toEqual(["AK", "NO", "OM", "SA"]);
    expect(screen.container.textContent).toContain("+2");
    const stack = screen.container.querySelector("[data-presence-stack]");
    expect(stack?.getAttribute("aria-label")).toMatch(/Ali Khan editing line 4, \w+\. /);
    expect(stack?.getAttribute("aria-label")).toMatch(/Ali's agent editing line 4, \w+$/);
  });

  it("paints avatars from the theme's presence tokens", async () => {
    await using screen = await render(<PresenceAvatarStack entries={[entry("c", aliAgent)]} />, {
      router: false,
    });
    const avatar = screen.container.querySelector<HTMLElement>("[data-presence-actor]")!;
    expect(avatar.style.backgroundColor).toBe(presenceColor(1));
    expect(avatar.className).toContain("rounded-sm");
    const painted = getComputedStyle(avatar).backgroundColor;
    expect(painted).not.toBe("rgba(0, 0, 0, 0)");
    for (let index = 0; index < PRESENCE_COLOR_COUNT; index += 1) {
      const token = getComputedStyle(document.documentElement).getPropertyValue(
        `--presence-${index}`,
      );
      expect(token.trim()).not.toBe("");
    }
  });

  it("renders nothing when nobody is here", async () => {
    await using screen = await render(<PresenceAvatarStack entries={[]} />, { router: false });
    expect(screen.container.childElementCount).toBe(0);
  });
});

describe("createPresenceCaretElement", () => {
  it("draws a coloured caret with the person's name", () => {
    const caret = createPresenceCaretElement({
      metadata: { color: presenceColor(3), name: "Noor", agent: false },
    });
    expect(caret.dataset.presenceCaret).toBe("Noor");
    expect(caret.style.background).toBe("var(--presence-3)");
    expect(caret.textContent).toBe("Noor");
  });
});
