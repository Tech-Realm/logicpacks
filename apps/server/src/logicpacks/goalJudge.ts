import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { JUDGE_INSTRUCTIONS, judgePrompt, parseVerdict } from "./goals.ts";
import { GoalJudge } from "./ProjectGoals.ts";

/**
 * The turn-end judgment on the text-generation path used for pull request text (same
 * model choice, fallbacks, limits): ON_PLAN or OFF_PLAN with a reason. Per goal ("AI
 * check"), rate-limited by ProjectGoals; `LOGICPACKS_GOALS_JUDGE=off` disables it.
 */
export const layerJudge = Layer.effect(
  GoalJudge,
  Effect.gen(function* () {
    const disabled = (process.env.LOGICPACKS_GOALS_JUDGE ?? "").toLowerCase() === "off";
    const textGeneration = yield* TextGeneration.TextGeneration;
    const settings = yield* ServerSettings.ServerSettingsService;
    const git = yield* GitVcsDriver.GitVcsDriver;
    return {
      judge: Effect.fn("GoalJudge.judge")(
        function* (input) {
          if (disabled) return null;
          const current = yield* settings.getSettings;
          const diff = yield* git
            .execute({
              operation: "logicpacks.goals.judge",
              cwd: input.cwd,
              args: ["diff", "--no-color", "--unified=2", "--", ...input.files.slice(0, 20)],
              allowNonZeroExit: true,
              timeoutMs: 15_000,
            })
            .pipe(
              Effect.map((result) => result.stdout.slice(0, 20_000)),
              Effect.orElseSucceed(() => ""),
            );
          const result = yield* textGeneration.generatePrContent({
            cwd: input.cwd,
            baseBranch: "milestone",
            headBranch: "turn",
            commitSummary: judgePrompt(input),
            diffSummary: input.files.join("\n") || "(no files)",
            diffPatch: diff || "(no diff)",
            policy: {
              kind: "custom",
              changeRequestInstructions: JUDGE_INSTRUCTIONS,
              inferRepositoryConventions: false,
            },
            modelSelection: current.textGenerationModelSelection,
          });
          return parseVerdict(result.title, result.body);
        },
        Effect.catchCause((cause) =>
          Effect.logDebug("Goal judgment unavailable", { cause }).pipe(Effect.as(null)),
        ),
      ),
    };
  }),
);
