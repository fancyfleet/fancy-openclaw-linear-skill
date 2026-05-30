/**
 * Public library entry — re-exports helpers that are safe to consume from
 * other Node packages (the Linear webhook in particular). The CLI binary
 * remains `src/index.ts`; this file must stay free of top-level side
 * effects so importing it does not run the commander program.
 */
export { getAgentWorkspaceDir, getLinearSecretPath } from "./paths.js";
export type { PathOptions } from "./paths.js";
