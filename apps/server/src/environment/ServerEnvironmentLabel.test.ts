import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { logicPacksHostLabel } from "./ServerEnvironmentLabel.ts";

const withEnv = (env: Record<string, string>) =>
  logicPacksHostLabel.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

it.effect("a cloud host never shows the machine name", () =>
  Effect.gen(function* () {
    assert.equal(yield* withEnv({ LOGICPACKS_CLOUD_HOST: "true" }), "LogicPacks cloud");
    assert.equal(
      yield* withEnv({ LOGICPACKS_CLOUD_HOST: "true", LOGICPACKS_HOST_LABEL: " Acme cloud " }),
      "Acme cloud",
    );
    assert.equal(yield* withEnv({ LOGICPACKS_HOST_LABEL: "Studio box" }), "Studio box");
  }),
);

it.effect("a desktop keeps its own machine label", () =>
  Effect.gen(function* () {
    assert.isNull(yield* withEnv({}));
    assert.isNull(yield* withEnv({ LOGICPACKS_CLOUD_HOST: "false" }));
  }),
);
