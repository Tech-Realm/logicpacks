/**
 * The recipes LogicPacks ships with, in picker order. Code is the default and
 * the only one the web build runs; Blender is in preview; the rest are coming
 * soon (real detect and launch data, no agent tools yet).
 */
import {
  DEFAULT_RECIPE_ID,
  RECIPE_FORMAT_VERSION,
  type RecipeCatalog,
  type RecipeIntegration,
  type RecipeManifest,
  type RecipeSurface,
  type RecipeTool,
} from "@logicpacks/contracts";

const comingSoon = (name: string, summary: string, mutates = true): RecipeTool => ({
  name,
  summary,
  status: "coming-soon",
  mutates,
});

const available = (name: string, summary: string, mutates = true): RecipeTool => ({
  name,
  summary,
  status: "available",
  mutates,
});

const COMING_SOON_LIMITATION =
  "Beta: detection and launch are declared, the agent tools are not built yet.";

export const CODE_RECIPE: RecipeManifest = {
  formatVersion: RECIPE_FORMAT_VERSION,
  id: DEFAULT_RECIPE_ID,
  name: "Code",
  summary: "Agents and teammates work in one repository, synced through GitHub and the cloud host.",
  surfaces: ["web", "desktop", "cloud"],
  availability: "available",
  apps: [],
  starterPrompts: ["Sync this project to the cloud", "Share this project with my team"],
};

const BLENDER_AGENT_INSTRUCTIONS = [
  "This project is a Blender scene shared through the LogicPacks Blender recipe.",
  "Work on the scene through the logicpacks-blender MCP tools (blender_status, blender_list_scene, blender_add_object, blender_modify_object, blender_delete_object, blender_run_op, blender_snapshot, blender_export_oplog, blender_merge), not by editing .blend files directly.",
  "Start with blender_status. If Blender is not running, ask the person to press Open Blender in LogicPacks, or run `logicpacks recipe launch blender` in the project folder.",
  "Every edit is recorded in the op log under .logicpacks/blender/<branch>/. To bring in someone else's work, call blender_merge with their op log and report any conflicts it returns instead of overwriting them.",
  "When the host shares Blender live (Any app), work in that window with `lp app run blender.<op>` (run `lp app ops` for the list): each op is logged under your name, your first edit takes a snapshot, and edits need the host's grant unless you run on the host.",
].join("\n");

export const BLENDER_RECIPE: RecipeManifest = {
  formatVersion: RECIPE_FORMAT_VERSION,
  id: "blender",
  name: "Blender",
  summary:
    "People and agents build one scene together. Each edit is logged per object, so separate work merges back with the clashes named.",
  surfaces: ["desktop", "cloud"],
  availability: "preview",
  apps: ["blender"],
  agentInstructions: BLENDER_AGENT_INSTRUCTIONS,
  starterPrompts: ["Add a camera looking at the cube", "List everything in the scene"],
  integration: {
    app: {
      name: "Blender",
      vendor: "Blender Foundation",
      homepage: "https://www.blender.org",
      download: "https://www.blender.org/download/",
    },
    platforms: ["macos", "windows", "linux"],
    detect: [
      {
        platform: "macos",
        paths: ["/Applications/Blender.app", "~/Applications/Blender.app"],
        commands: ["blender"],
      },
      {
        platform: "linux",
        paths: ["/usr/bin/blender", "/snap/bin/blender"],
        commands: ["blender"],
      },
      {
        platform: "windows",
        paths: ["C:\\Program Files\\Blender Foundation\\Blender\\blender.exe"],
        commands: ["blender"],
      },
    ],
    launch: [
      {
        platform: "macos",
        executable: "{app}/Contents/MacOS/Blender",
        args: [
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
        ],
        headlessArgs: [
          "-b",
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
          "--serve",
        ],
      },
      {
        platform: "linux",
        executable: "{app}",
        args: [
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
        ],
        headlessArgs: [
          "-b",
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
          "--serve",
        ],
      },
      {
        platform: "windows",
        executable: "{app}",
        args: [
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
        ],
        headlessArgs: [
          "-b",
          "{file}",
          "--python",
          "{asset:blender/logicpacks_bridge.py}",
          "--",
          "--session",
          "{session}",
          "--serve",
        ],
      },
    ],
    adapter: {
      kind: "socket-addon",
      summary:
        "A bundled add-on opens a local socket inside Blender. Agents reach it through an MCP server run by the logicpacks CLI.",
      assets: ["blender/logicpacks_bridge.py"],
      mcp: {
        serverName: "logicpacks-blender",
        command: "logicpacks",
        args: ["recipe", "mcp", "blender", "--session", "{session}"],
      },
    },
    tools: [
      available("blender_status", "Is Blender connected, which file, how many ops so far.", false),
      available(
        "blender_list_scene",
        "Every object with its id, type, transform and visibility.",
        false,
      ),
      available("blender_add_object", "Add a primitive, empty, camera or light."),
      available(
        "blender_modify_object",
        "Set name, transform, parent, visibility or light and camera values.",
      ),
      available("blender_delete_object", "Remove an object."),
      available(
        "blender_run_op",
        "Run any bpy.ops operator. Its effect is recorded like any other edit.",
      ),
      available(
        "blender_snapshot",
        "Save a copy of the .blend and mark the op log position, to branch from.",
        false,
      ),
      available(
        "blender_export_oplog",
        "Read the op log, or write it to a file as JSON lines.",
        false,
      ),
      available(
        "blender_merge",
        "Merge another branch's ops into this scene. Returns the conflicts it did not apply.",
      ),
    ],
    opLog: {
      unit: "object property",
      mergeGranularity: "object and property, three-way against the common op prefix",
      snapshot: ".blend copy plus op log position",
      recordedBy:
        "the bundled add-on, diffing tracked properties after every tool call and twice a second for edits made by hand",
    },
    limitations: [
      "Mesh geometry edits (edit mode) are not merged, only object level properties.",
      "Objects added by a merge are rebuilt from their primitive, not copied vertex for vertex.",
      "Materials, modifiers and animation are not tracked yet.",
    ],
  },
};

type ComingSoonInput = Omit<RecipeIntegration, "opLog" | "limitations"> &
  Partial<Pick<RecipeIntegration, "opLog" | "limitations">> & {
    readonly id: string;
    readonly runtimes: readonly [RecipeSurface, ...RecipeSurface[]];
  };

const comingSoonRecipe = (
  name: string,
  summary: string,
  { id: recipeId, runtimes, opLog, limitations, ...integration }: ComingSoonInput,
): RecipeManifest => ({
  formatVersion: RECIPE_FORMAT_VERSION,
  id: recipeId,
  name,
  summary,
  surfaces: runtimes,
  availability: "coming-soon",
  apps: [recipeId],
  integration: {
    ...integration,
    opLog: opLog ?? {
      unit: "not decided",
      mergeGranularity: "not decided",
      snapshot: "not decided",
      recordedBy: "not decided",
    },
    limitations: [COMING_SOON_LIMITATION, ...(limitations ?? [])],
  },
});

export const DAVINCI_RESOLVE_RECIPE = comingSoonRecipe(
  "DaVinci Resolve",
  "Cut a timeline together. Agents add clips, markers and renders through Resolve's scripting API.",
  {
    id: "davinci-resolve",
    app: {
      name: "DaVinci Resolve",
      vendor: "Blackmagic Design",
      homepage: "https://www.blackmagicdesign.com/products/davinciresolve",
    },
    runtimes: ["desktop"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      { platform: "macos", paths: ["/Applications/DaVinci Resolve/DaVinci Resolve.app"] },
      {
        platform: "windows",
        paths: ["C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe"],
      },
      { platform: "linux", paths: ["/opt/resolve/bin/resolve"] },
    ],
    launch: [
      { platform: "macos", executable: "{app}/Contents/MacOS/Resolve", args: [] },
      { platform: "windows", executable: "{app}", args: [] },
      { platform: "linux", executable: "{app}", args: [] },
    ],
    adapter: {
      kind: "scripting-api",
      summary:
        "DaVinciResolveScript (Python), reached from an external script with scripting set to Local. External scripting needs DaVinci Resolve Studio; with the free edition, agents use the Any app ops (menus, keys, screenshots) on the shared window.",
      assets: [],
    },
    tools: [
      comingSoon(
        "resolve_list_timelines",
        "Timelines, tracks and clips in the current project.",
        false,
      ),
      comingSoon("resolve_append_clip", "Put a media pool clip on a track."),
      comingSoon("resolve_add_marker", "Mark a frame with a note."),
      comingSoon("resolve_render", "Queue and start a render preset."),
    ],
    opLog: {
      unit: "timeline item",
      mergeGranularity: "clip and marker",
      snapshot: "project export (.drp)",
      recordedBy: "polling the scripting API",
    },
  },
);

export const BROWSER_RECIPE = comingSoonRecipe(
  "Browser",
  "Drive a real browser side by side: agents navigate, click and read pages while you watch.",
  {
    id: "browser",
    app: { name: "Chrome or Chromium", homepage: "https://www.chromium.org" },
    runtimes: ["desktop", "cloud"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      {
        platform: "macos",
        paths: ["/Applications/Google Chrome.app", "/Applications/Chromium.app"],
      },
      {
        platform: "linux",
        paths: [],
        commands: ["google-chrome", "chromium", "chromium-browser"],
      },
      {
        platform: "windows",
        paths: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      },
    ],
    launch: [
      {
        platform: "macos",
        executable: "{app}/Contents/MacOS/Google Chrome",
        args: ["--remote-debugging-port=0", "--user-data-dir={session}/profile"],
        headlessArgs: [
          "--headless=new",
          "--remote-debugging-port=0",
          "--user-data-dir={session}/profile",
        ],
      },
      { platform: "linux", executable: "{app}", args: ["--remote-debugging-port=0"] },
      { platform: "windows", executable: "{app}", args: ["--remote-debugging-port=0"] },
    ],
    adapter: {
      kind: "cdp",
      summary:
        "Chrome DevTools Protocol on a private profile, never the person's own browser profile.",
      assets: [],
    },
    tools: [
      comingSoon("browser_navigate", "Open a URL in the shared tab."),
      comingSoon("browser_click", "Click an element by selector or text."),
      comingSoon("browser_read", "Read the page as text and links.", false),
      comingSoon("browser_screenshot", "Capture the visible tab.", false),
    ],
  },
);

export const GODOT_RECIPE = comingSoonRecipe(
  "Godot",
  "Build a game scene together. An editor plugin exposes the node tree to agents.",
  {
    id: "godot",
    app: { name: "Godot Engine", homepage: "https://godotengine.org" },
    runtimes: ["desktop", "cloud"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      { platform: "macos", paths: ["/Applications/Godot.app"], commands: ["godot"] },
      { platform: "linux", paths: [], commands: ["godot", "godot4"] },
      { platform: "windows", paths: [], commands: ["godot"] },
    ],
    launch: [
      {
        platform: "macos",
        executable: "{app}/Contents/MacOS/Godot",
        args: ["--editor", "--path", "{project}"],
      },
      { platform: "linux", executable: "{app}", args: ["--editor", "--path", "{project}"] },
      { platform: "windows", executable: "{app}", args: ["--editor", "--path", "{project}"] },
    ],
    adapter: {
      kind: "socket-addon",
      summary: "An EditorPlugin listening on a local socket, the same shape as the Blender add-on.",
      assets: [],
    },
    tools: [
      comingSoon("godot_list_nodes", "The open scene's node tree.", false),
      comingSoon("godot_add_node", "Add a node under a parent."),
      comingSoon("godot_set_property", "Set a node property."),
      comingSoon("godot_run_scene", "Play the current scene.", false),
    ],
    opLog: {
      unit: "node property",
      mergeGranularity: "node and property",
      snapshot: ".tscn copy",
      recordedBy: "EditorUndoRedoManager history",
    },
  },
);

export const REAPER_RECIPE = comingSoonRecipe(
  "Reaper",
  "Mix and arrange together. Agents add tracks, items and effects through ReaScript.",
  {
    id: "reaper",
    app: { name: "REAPER", vendor: "Cockos", homepage: "https://www.reaper.fm" },
    runtimes: ["desktop"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      { platform: "macos", paths: ["/Applications/REAPER.app"] },
      { platform: "windows", paths: ["C:\\Program Files\\REAPER (x64)\\reaper.exe"] },
      { platform: "linux", paths: ["~/opt/REAPER/reaper"] },
    ],
    launch: [
      { platform: "macos", executable: "{app}/Contents/MacOS/REAPER", args: [] },
      { platform: "windows", executable: "{app}", args: [] },
      { platform: "linux", executable: "{app}", args: [] },
    ],
    adapter: {
      kind: "scripting-api",
      summary:
        "A ReaScript (Lua) bridge started from the Actions list, talking over a local socket.",
      assets: [],
    },
    tools: [
      comingSoon("reaper_list_tracks", "Tracks, items and FX chains.", false),
      comingSoon("reaper_add_track", "Add a named track."),
      comingSoon("reaper_set_volume", "Set a track's volume and pan."),
      comingSoon("reaper_add_fx", "Insert an effect on a track."),
      comingSoon("reaper_render", "Render the project with its saved settings.", false),
    ],
  },
);

export const OFFICE_RECIPE = comingSoonRecipe(
  "Office and Sheets",
  "Work in the same spreadsheet or document. Agents read and write ranges, people see who changed what.",
  {
    id: "office",
    app: { name: "LibreOffice or Microsoft Excel", homepage: "https://www.libreoffice.org" },
    runtimes: ["desktop", "cloud"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      {
        platform: "macos",
        paths: ["/Applications/LibreOffice.app", "/Applications/Microsoft Excel.app"],
      },
      { platform: "linux", paths: [], commands: ["soffice", "libreoffice"] },
      { platform: "windows", paths: ["C:\\Program Files\\LibreOffice\\program\\soffice.exe"] },
    ],
    launch: [
      {
        platform: "macos",
        executable: "{app}/Contents/MacOS/soffice",
        args: ["--accept=socket,host=127.0.0.1,port=0;urp;", "{file}"],
        headlessArgs: ["--headless", "--accept=socket,host=127.0.0.1,port=0;urp;"],
      },
      {
        platform: "linux",
        executable: "{app}",
        args: ["--accept=socket,host=127.0.0.1,port=0;urp;"],
      },
      {
        platform: "windows",
        executable: "{app}",
        args: ["--accept=socket,host=127.0.0.1,port=0;urp;"],
      },
    ],
    adapter: {
      kind: "scripting-api",
      summary:
        "LibreOffice UNO over a local socket. Google Sheets would go through its API instead.",
      assets: [],
    },
    tools: [
      comingSoon("sheet_read_range", "Read cells as a table.", false),
      comingSoon("sheet_write_range", "Write values or formulas."),
      comingSoon("sheet_add_sheet", "Add a named sheet."),
    ],
    opLog: {
      unit: "cell",
      mergeGranularity: "cell",
      snapshot: "document copy",
      recordedBy: "UNO modify listeners",
    },
  },
);

export const JUPYTER_RECIPE = comingSoonRecipe(
  "Jupyter",
  "Share a notebook and its kernel. Agents add and run cells, people see outputs as they land.",
  {
    id: "jupyter",
    app: { name: "Jupyter", homepage: "https://jupyter.org" },
    runtimes: ["desktop", "cloud"],
    platforms: ["macos", "windows", "linux"],
    detect: [
      { platform: "macos", paths: [], commands: ["jupyter"] },
      { platform: "linux", paths: [], commands: ["jupyter"] },
      { platform: "windows", paths: [], commands: ["jupyter"] },
    ],
    launch: [
      { platform: "macos", executable: "{app}", args: ["lab", "--no-browser", "--port=0"] },
      { platform: "linux", executable: "{app}", args: ["lab", "--no-browser", "--port=0"] },
      { platform: "windows", executable: "{app}", args: ["lab", "--no-browser", "--port=0"] },
    ],
    adapter: {
      kind: "stdio",
      summary: "The Jupyter server REST and kernel websocket APIs, wrapped as MCP tools.",
      assets: [],
    },
    tools: [
      comingSoon("jupyter_list_cells", "Cells and their last outputs.", false),
      comingSoon("jupyter_add_cell", "Insert a code or markdown cell."),
      comingSoon("jupyter_run_cell", "Execute a cell on the shared kernel."),
    ],
    opLog: {
      unit: "cell",
      mergeGranularity: "cell source",
      snapshot: ".ipynb copy",
      recordedBy: "notebook model change events",
    },
  },
);

/** In picker order: the default first, then what works, then what is coming. */
export const BUILT_IN_RECIPES: ReadonlyArray<RecipeManifest> = [
  CODE_RECIPE,
  BLENDER_RECIPE,
  DAVINCI_RESOLVE_RECIPE,
  BROWSER_RECIPE,
  GODOT_RECIPE,
  REAPER_RECIPE,
  OFFICE_RECIPE,
  JUPYTER_RECIPE,
];

export const builtInRecipeCatalog = (): RecipeCatalog => ({
  defaultRecipeId: DEFAULT_RECIPE_ID,
  recipes: BUILT_IN_RECIPES,
});

export function findBuiltInRecipe(recipeId: string): RecipeManifest | undefined {
  return BUILT_IN_RECIPES.find((recipe) => recipe.id === recipeId);
}
