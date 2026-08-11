import type { InlineExtension } from "../core/extensions/types.ts";
import axiomLedgerExtension from "./ledger/index.ts";
import llamaExtension from "./llama/index.ts";
import axiomMemoryExtension from "./memory/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "axiom-ledger", factory: axiomLedgerExtension },
	{ name: "axiom-memory", factory: axiomMemoryExtension },
];
