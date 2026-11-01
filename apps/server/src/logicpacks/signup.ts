import * as Config from "effect/Config";

/**
 * Who may create an account: `open` (anyone), `invite` (only through a valid invite or share
 * link) or `closed` (nobody new). Unknown values count as `invite`.
 */
export type SignupMode = "open" | "invite" | "closed";
export const parseSignupMode = (raw: string | undefined): SignupMode => {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "open") return "open";
  return value === "closed" ? "closed" : "invite";
};
export const signupMode = Config.String("LOGICPACKS_SIGNUP").pipe(
  Config.withDefault(""),
  Config.map(parseSignupMode),
);
