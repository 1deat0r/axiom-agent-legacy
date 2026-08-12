/**
 * Message normalization + command detection (ADR-0001: commands are
 * gateway-local and never reach the model).
 */
import type { GatewayMessage } from "./types.js";

/** True when the first token of the trimmed text starts with a single "/". */
export function isCommandText(text: string): boolean {
	const t = text.trim();
	return t.length > 1 && t.startsWith("/") && !t.startsWith("//");
}

/** The first whitespace-delimited token (the command name for commands). */
export function firstToken(text: string): string {
	const t = text.trim();
	const space = t.search(/\s/);
	return space < 0 ? t : t.slice(0, space);
}

/** Build a typed inbound message from a transport's raw event. */
export function toGatewayMessage(raw: {
	channelId: string;
	sender: string;
	text: string;
	timestamp?: number;
}): GatewayMessage {
	return {
		channelId: raw.channelId,
		sender: raw.sender,
		text: raw.text,
		isCommand: isCommandText(raw.text),
		timestamp: raw.timestamp ?? Date.now(),
	};
}
