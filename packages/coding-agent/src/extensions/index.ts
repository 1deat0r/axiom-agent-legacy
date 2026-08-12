import type { ExtensionFactory } from "../core/extensions/types.js";
import axiomLedgerExtension from "./ledger/index.js";
import axiomMemoryExtension from "./memory/index.js";
import axiomProfileExtension from "./profile/index.js";
import axiomRecallExtension from "./recall/index.js";
import axiomWorkspaceExtension from "./workspace/index.js";

/** Axiom built-in extensions, wired into main() alongside the baseline's own. */
export const builtInExtensions: ExtensionFactory[] = [
	axiomLedgerExtension,
	axiomMemoryExtension,
	axiomProfileExtension,
	axiomRecallExtension,
	axiomWorkspaceExtension,
];
