// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure path helper used before any Effect runtime exists.
import * as NodePath from "node:path";
import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(logicpacksHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(logicpacksHome)) {
    return Option.none();
  }
  const trimmed = logicpacksHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly logicpacksHome: Option.Option<string>;
  /**
   * Picks the default home's directory name. Production passes `migrateDefaultHomeDirectoryName`,
   * which copies the pre-rename ~/.logicpacks into ~/.logicpacks once; tests leave it out.
   */
  readonly defaultHomeDirectoryName?: (homeDirectory: string) => string;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.logicpacksHome), () =>
    input.joinPath(
      input.homeDirectory,
      input.defaultHomeDirectoryName?.(input.homeDirectory) ?? ".logicpacks",
    ),
  );
}

export function migrateDefaultHomeDirectoryName(_homeDirectory: string): string {
  return ".logicpacks";
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly logicpacksHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.logicpacksHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
