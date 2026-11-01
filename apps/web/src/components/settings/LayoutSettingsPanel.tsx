import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import {
  type LayoutMode,
  type WorkspaceSurface,
  LAYOUT_WIDTH_LIMITS,
  allLayoutModes,
  duplicateLayoutMode,
  isBuiltInLayoutMode,
  parseLayoutModesJson,
  serializeLayoutModes,
  workspaceBeforeChat,
} from "~/layoutModes/layoutModes";
import { LayoutModePreview } from "~/layoutModes/LayoutModePreview";
import {
  deleteCustomLayoutMode,
  importCustomLayoutModes,
  saveCustomLayoutMode,
  setActiveLayoutMode,
  useActiveLayoutMode,
  useUserPrefsStore,
} from "~/layoutModes/userPrefsStore";
import { requestTourReplay } from "~/productTour/productTourStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTO_OPEN_LABELS: Record<WorkspaceSurface, string> = {
  none: "Nothing",
  files: "Files",
  diff: "Diff",
};

/** Settings, Layout: pick a mode, make custom ones, move them between machines as JSON. */
export function LayoutSettingsPanel() {
  const active = useActiveLayoutMode();
  const customModes = useUserPrefsStore((state) => state.prefs.layout.customModes);
  const syncStatus = useUserPrefsStore((state) => state.status);
  const [editing, setEditing] = useState<LayoutMode | null>(null);
  const modes = allLayoutModes(customModes);

  const duplicate = (source: LayoutMode) => {
    const copy = duplicateLayoutMode(source, customModes);
    saveCustomLayoutMode(copy);
    setActiveLayoutMode(copy.id);
    setEditing(copy);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("layout-modes")}
        title="Layout"
        headerAction={
          <span className="text-xs text-muted-foreground" data-testid="lp-layout-sync">
            {syncStatus === "ready"
              ? "Synced to your account"
              : syncStatus === "offline"
                ? "Saved on this device"
                : ""}
          </span>
        }
      >
        <div
          role="radiogroup"
          aria-label="Layout mode"
          className="grid grid-cols-2 gap-px bg-hairline sm:grid-cols-3"
        >
          {modes.map((mode) => {
            const checked = mode.id === active.id;
            return (
              <div
                key={mode.id}
                className={cn("flex flex-col gap-2 bg-background p-3", checked && "bg-accent")}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-testid={`lp-layout-mode-${mode.id}`}
                  onClick={() => setActiveLayoutMode(mode.id)}
                  className="flex flex-col gap-2 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <LayoutModePreview mode={mode} />
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      aria-hidden
                      className={cn(
                        "size-3 shrink-0 rounded-full border border-foreground/50",
                        checked && "border-4 border-foreground",
                      )}
                    />
                    {mode.label}
                    {isBuiltInLayoutMode(mode.id) ? (
                      <span className="text-2xs font-normal text-muted-foreground">Built in</span>
                    ) : null}
                  </span>
                  {mode.description ? (
                    <span className="text-xs text-muted-foreground">{mode.description}</span>
                  ) : null}
                </button>
                <div className="flex gap-1">
                  <Button
                    size="micro"
                    variant="outline"
                    onClick={() => duplicate(mode)}
                    data-testid={`lp-layout-duplicate-${mode.id}`}
                  >
                    Duplicate
                  </Button>
                  {isBuiltInLayoutMode(mode.id) ? null : (
                    <>
                      <Button
                        size="micro"
                        variant="outline"
                        onClick={() => setEditing(mode)}
                        data-testid={`lp-layout-edit-${mode.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="micro"
                        variant="ghost"
                        onClick={() => {
                          deleteCustomLayoutMode(mode.id);
                          if (editing?.id === mode.id) setEditing(null);
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {editing ? (
        <LayoutModeEditor key={editing.id} mode={editing} onDone={() => setEditing(null)} />
      ) : null}

      <LayoutImportExport customModes={customModes} />

      <SettingsSection {...searchableSetting("product-tour")} title="Tour">
        <ReplayTourRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ReplayTourRow() {
  const navigate = useNavigate();
  return (
    <SettingsRow
      title="Replay tour"
      description="Walk through the room again: people, sharing, tools, the composer and layouts."
      control={
        <Button
          size="sm"
          variant="outline"
          data-testid="lp-replay-tour"
          onClick={() => {
            requestTourReplay();
            // The tour runs in the project room, not over Settings.
            if (window.history.length > 1) window.history.back();
            else void navigate({ to: "/" });
          }}
        >
          Replay tour
        </Button>
      }
    />
  );
}

function LayoutModeEditor({
  mode,
  onDone,
}: {
  readonly mode: LayoutMode;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState(mode);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const workspaceFirst = workspaceBeforeChat(draft);

  const save = () => {
    const result = parseLayoutModesJson(JSON.stringify(draft));
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    saveCustomLayoutMode(result.modes[0]!);
    toastManager.add({ type: "success", title: `Saved ${draft.label}`, timeout: 1500 });
    onDone();
  };

  const setOpen = (key: keyof LayoutMode["open"], value: boolean) =>
    setDraft({ ...draft, open: { ...draft.open, [key]: value } });

  return (
    <SettingsSection title={`Edit ${mode.label}`} data-testid="lp-layout-editor">
      <SettingsRow
        title="Name"
        control={
          <Input
            aria-label="Layout name"
            data-testid="lp-layout-name"
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        }
      />
      <SettingsRow
        title="Panel order"
        description={workspaceFirst ? "Projects, workspace, chat" : "Projects, chat, workspace"}
        control={
          <Button
            size="sm"
            variant="outline"
            data-testid="lp-layout-swap"
            onClick={() =>
              setDraft({
                ...draft,
                order: workspaceFirst
                  ? ["projects", "chat", "workspace"]
                  : ["projects", "workspace", "chat"],
              })
            }
          >
            Swap chat and workspace
          </Button>
        }
      />
      <SettingsRow
        title="Projects sidebar open"
        control={
          <Switch
            aria-label="Projects sidebar open"
            checked={draft.open.projects}
            onCheckedChange={(checked) => setOpen("projects", Boolean(checked))}
          />
        }
      />
      <SettingsRow
        title="Workspace panel open"
        control={
          <Switch
            aria-label="Workspace panel open"
            data-testid="lp-layout-open-workspace"
            checked={draft.open.workspace}
            onCheckedChange={(checked) => setOpen("workspace", Boolean(checked))}
          />
        }
      />
      <SettingsRow
        title="Terminal open"
        control={
          <Switch
            aria-label="Terminal open"
            checked={draft.open.terminal}
            onCheckedChange={(checked) => setOpen("terminal", Boolean(checked))}
          />
        }
      />
      <SettingsRow
        title="When a thread opens, show"
        control={
          <div role="radiogroup" aria-label="Auto-open" className="flex gap-1">
            {(Object.keys(AUTO_OPEN_LABELS) as WorkspaceSurface[]).map((surface) => (
              <Button
                key={surface}
                size="sm"
                role="radio"
                aria-checked={draft.autoOpen === surface}
                variant={draft.autoOpen === surface ? "default" : "outline"}
                onClick={() => setDraft({ ...draft, autoOpen: surface })}
              >
                {AUTO_OPEN_LABELS[surface]}
              </Button>
            ))}
          </div>
        }
      />
      {(["projects", "workspace"] as const).map((key) => (
        <SettingsRow
          key={key}
          title={key === "projects" ? "Projects width" : "Workspace width"}
          description={`${LAYOUT_WIDTH_LIMITS[key].min} to ${LAYOUT_WIDTH_LIMITS[key].max} pixels`}
          control={
            <Input
              type="number"
              aria-label={key === "projects" ? "Projects width" : "Workspace width"}
              data-testid={`lp-layout-width-${key}`}
              value={String(draft.widths[key])}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  widths: { ...draft.widths, [key]: Number(event.target.value) },
                })
              }
            />
          }
        />
      ))}
      <div className="flex flex-col gap-3 p-4">
        <LayoutModePreview mode={draft} className="max-w-xs" />
        <ErrorList errors={errors} />
        <div className="flex gap-2">
          <Button size="sm" onClick={save} data-testid="lp-layout-save">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

function ErrorList({ errors }: { readonly errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul
      role="alert"
      data-testid="lp-layout-errors"
      className="flex flex-col gap-1 text-xs text-destructive-foreground"
    >
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

function LayoutImportExport({ customModes }: { readonly customModes: readonly LayoutMode[] }) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<readonly string[]>([]);
  const json = serializeLayoutModes(customModes);
  const nothingToExport = customModes.length === 0;

  const importText = (value: string) => {
    const result = parseLayoutModesJson(value);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setText("");
    importCustomLayoutModes(result.modes);
    toastManager.add({
      type: "success",
      title: `Imported ${result.modes.length} ${result.modes.length === 1 ? "layout" : "layouts"}`,
      timeout: 2000,
    });
  };

  return (
    <SettingsSection {...searchableSetting("layout-import-export")} title="Import and export">
      <SettingsRow
        title="Your layouts as JSON"
        description={
          nothingToExport
            ? "Duplicate Dev or Vibe first. Built-in layouts are not exported."
            : "Copy or download your custom layouts to use them on another account or share them."
        }
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={nothingToExport}
              data-testid="lp-layout-copy-json"
              onClick={() =>
                void navigator.clipboard
                  .writeText(json)
                  .then(() => toastManager.add({ title: "Copied layout JSON", timeout: 1500 }))
                  .catch(() => toastManager.add({ type: "error", title: "Could not copy" }))
              }
            >
              Copy JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={nothingToExport}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = "logicpacks-layouts.json";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Import layouts"
        description="Upload a .json file, or paste it below. Layouts with the same id are replaced."
        control={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              data-testid="lp-layout-upload"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void file.text().then(importText);
              }}
            />
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
              Upload
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-2 p-4">
        <Textarea
          aria-label="Layout JSON"
          data-testid="lp-layout-paste"
          placeholder='{ "version": 1, "modes": [ ... ] }'
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
        />
        <ErrorList errors={errors} />
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={!text.trim()}
            onClick={() => importText(text)}
            data-testid="lp-layout-import"
          >
            Import
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
