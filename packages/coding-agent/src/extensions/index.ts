import type { ExtensionFactory } from "../core/extensions/types.js";
import axiomDelegateExtension from "./delegate/index.js";
import axiomGitGuardExtension from "./git-guard/index.js";
import axiomLedgerExtension from "./ledger/index.js";
import axiomMemoryExtension from "./memory/index.js";
import axiomMemoryConsolidationExtension from "./memory-consolidation/index.js";
import axiomPeersExtension from "./peers/index.js";
import axiomProfileExtension from "./profile/index.js";
import axiomRecallExtension from "./recall/index.js";
import axiomScheduleExtension from "./schedule/index.js";
import axiomSecurityExtension from "./security/index.js";
import axiomSkillCaptureExtension from "./skill-capture/index.js";
import axiomWorkspaceExtension from "./workspace/index.js";

/** Axiom built-in extensions, wired into main() alongside the baseline's own. */
export const builtInExtensions: ExtensionFactory[] = [
	axiomDelegateExtension,
	axiomGitGuardExtension,
	axiomLedgerExtension,
	axiomMemoryConsolidationExtension,
	axiomMemoryExtension,
	axiomPeersExtension,
	axiomProfileExtension,
	axiomRecallExtension,
	axiomScheduleExtension,
	axiomSkillCaptureExtension,
	axiomSecurityExtension,
	axiomWorkspaceExtension,
];
