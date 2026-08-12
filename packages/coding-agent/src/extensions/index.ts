import type { ExtensionFactory } from "../core/extensions/types.js";
import axiomDelegateExtension from "./delegate/index.js";
import axiomLedgerExtension from "./ledger/index.js";
import axiomMemoryExtension from "./memory/index.js";
import axiomProfileExtension from "./profile/index.js";
import axiomRecallExtension from "./recall/index.js";
import axiomSecurityExtension from "./security/index.js";
import axiomSkillCaptureExtension from "./skill-capture/index.js";
import axiomWorkspaceExtension from "./workspace/index.js";

/** Axiom built-in extensions, wired into main() alongside the baseline's own. */
export const builtInExtensions: ExtensionFactory[] = [
	axiomDelegateExtension,
	axiomLedgerExtension,
	axiomMemoryExtension,
	axiomProfileExtension,
	axiomRecallExtension,
	axiomSkillCaptureExtension,
	axiomSecurityExtension,
	axiomWorkspaceExtension,
];
