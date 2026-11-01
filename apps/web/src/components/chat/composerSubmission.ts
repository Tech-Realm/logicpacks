import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@logicpacks/contracts";
import { expandAssistantCitationsForProvider } from "@logicpacks/shared/assistantCitations";

type ComposerSubmitEvent = { preventDefault: () => void };

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
};

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    normalizedPrompt.length,
    expandAssistantCitationsForProvider(normalizedPrompt).length,
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}

/**
 * A send pressed while the environment is still (re)connecting, e.g. right after Connect
 * Claude, is held and dispatched once the connection is back instead of being dropped.
 */
export function shouldHoldComposerSubmit(input: {
  readonly environmentUnavailable: boolean;
  readonly hasSendableContent: boolean;
  readonly answeringPendingInput: boolean;
}): boolean {
  return input.environmentUnavailable && input.hasSendableContent && !input.answeringPendingInput;
}

/** Whether a held send can go out now, or should be dropped because the draft emptied. */
export function resolveHeldComposerSubmit(input: {
  readonly environmentUnavailable: boolean;
  readonly canOperate: boolean;
  readonly hasSendableContent: boolean;
}): "wait" | "send" | "cancel" {
  if (!input.hasSendableContent) return "cancel";
  if (input.environmentUnavailable || !input.canOperate) return "wait";
  return "send";
}
