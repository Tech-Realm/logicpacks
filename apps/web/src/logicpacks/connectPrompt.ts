/**
 * "Use your own agent": the prompt a person pastes into Claude Code, Codex, Cursor, Hermes or
 * any other agent. Same text as `lp setup-prompt` (packages/helper/src/connectText.ts; a helper
 * test keeps the two equal).
 */
export const CONNECT_AGENT_PROMPT = [
  "Set up LogicPacks for me: read https://logicpacks.io/setup.md and follow it.",
  "Install the helper, connect it to the LogicPacks app on this computer, and add the LogicPacks block to your global instructions.",
  "Show me what you'll change first and wait for my OK before you write anything.",
  "Then share this project and give me an invite link.",
].join("\n");
