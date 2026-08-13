import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { ConnectorTokenInputComponent } from "../src/modes/interactive/components/connector-token-input.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("ConnectorTokenInputComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders the titled box with a paste field and hints", () => {
		const component = new ConnectorTokenInputComponent("Telegram token", "message @BotFather to get one");
		const rendered = stripAnsi(component.render(70).join("\n"));
		expect(rendered).toContain("Telegram token");
		expect(rendered).toContain("message @BotFather to get one");
		expect(rendered).toContain("Paste the token");
		expect(rendered).toContain("submit");
	});

	test("submits the pasted value on Enter", async () => {
		const component = new ConnectorTokenInputComponent("t", "s");
		const pending = component.waitForSubmit();
		// Type the token through the component's routing (pastes/keys land in the field).
		for (const chunk of ["123", ":ABC"]) component.handleInput(chunk);
		component.handleInput("\r");
		await expect(pending).resolves.toBe("123:ABC");
	});

	test("resolves undefined on Escape", async () => {
		const component = new ConnectorTokenInputComponent("t", "s");
		const pending = component.waitForSubmit();
		component.handleInput("\u001b");
		await expect(pending).resolves.toBeUndefined();
	});

	test("is focusable so the overlay routes input through it", () => {
		const component = new ConnectorTokenInputComponent("t", "s");
		expect(component.focused).toBe(false);
		component.focused = true;
		expect(component.focused).toBe(true);
	});

	test("empty submit resolves an empty string for the handler to treat as cancel", async () => {
		const component = new ConnectorTokenInputComponent("t", "s");
		const pending = component.waitForSubmit();
		component.handleInput("\r");
		await expect(pending).resolves.toBe("");
	});
});
