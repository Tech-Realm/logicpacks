/**
 * Which recipes a client may use. Web is Code only: every other recipe drives an
 * app on someone's machine, so web shows them with a desktop download instead.
 * The CLI, the server and the picker all ask `recipeAccess`, so they agree.
 */
import type { RecipeManifest, RecipePlatform, RecipeSurface } from "@logicpacks/contracts";

export type RecipeAccess =
  /** Usable right here. */
  | { readonly kind: "open" }
  /** Works, but only in the desktop app. */
  | { readonly kind: "open-in-desktop"; readonly message: string }
  /** Declared, not built. Shown so people can see what is coming. */
  | { readonly kind: "coming-soon"; readonly message: string };

export const OPEN_IN_DESKTOP_MESSAGE = "Needs the LogicPacks desktop app";
export const COMING_SOON_MESSAGE = "Beta";

export function recipeAccess(
  recipe: Pick<RecipeManifest, "availability" | "surfaces">,
  client: RecipeSurface,
): RecipeAccess {
  if (recipe.availability === "coming-soon") {
    return { kind: "coming-soon", message: COMING_SOON_MESSAGE };
  }
  if (recipe.surfaces.includes(client)) {
    return { kind: "open" };
  }
  return { kind: "open-in-desktop", message: OPEN_IN_DESKTOP_MESSAGE };
}

export function platformFromNodePlatform(platform: string): RecipePlatform | null {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return null;
  }
}

/** A branch name that is safe as a single directory component. */
export function normaliseRecipeBranch(branch: string | undefined): string {
  const cleaned = (branch ?? "main")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "main";
}
