/**
 * Connector token input (ADR-0036): a small boxed paste field for the
 * `/connectors` "Set token" action. Enter submits (onSubmit), Escape closes
 * without saving. Shown over the chat via showFullPaneOverlay.
 */
import { Container, type Focusable, getKeybindings, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import { MenuPanel, MenuSearchInput } from "./menu-panel.js";

export class ConnectorTokenInputComponent extends Container implements Focusable {
	private readonly input: MenuSearchInput;
	private resolver?: (value: string | undefined) => void;
	private _focused = false;

	constructor(title: string, subtitle: string) {
		super();
		const panel = new MenuPanel({ title, subtitle });
		this.addChild(panel);
		this.input = new MenuSearchInput("Paste the token");
		this.input.onSubmit = () => {
			const resolver = this.resolver;
			this.resolver = undefined;
			resolver?.(this.input.getValue().trim());
		};
		panel.addChild(this.input);
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`),
				2,
				0,
			),
		);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Resolve when the user submits (value) or cancels (undefined). */
	waitForSubmit(): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.resolver = resolve;
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			const resolver = this.resolver;
			this.resolver = undefined;
			resolver?.(undefined);
			return;
		}
		this.input.handleInput(data);
	}
}
