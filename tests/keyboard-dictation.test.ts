import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionForBinding, bindingForAction, eventBinding } from "../src/core/keyboard.ts";

/**
 * Dictation moved ⌘D → ⌥D (owner, 2026-10-27). macOS Option composes a
 * character (⌥D types "∂"), so eventBinding reads alt+letter/digit from
 * the PHYSICAL key — otherwise "alt+d" could never match on a Mac (and a
 * Settings rebind would capture "alt+∂").
 */

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
	return { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

describe("eventBinding — alt reads the physical key", () => {
	it("macOS ⌥D (key \"∂\") normalizes to alt+d", () => {
		assert.equal(eventBinding(key({ key: "∂", code: "KeyD", altKey: true })), "alt+d");
	});

	it("Alt+D elsewhere (key \"d\") normalizes to alt+d", () => {
		assert.equal(eventBinding(key({ key: "d", code: "KeyD", altKey: true })), "alt+d");
	});

	it("alt digits and shifted alt letters use the physical key too", () => {
		assert.equal(eventBinding(key({ key: "¡", code: "Digit1", altKey: true })), "alt+1");
		assert.equal(eventBinding(key({ key: "Î", code: "KeyD", altKey: true, shiftKey: true })), "alt+shift+d");
	});

	it("non-alt and non-letter keys are unchanged", () => {
		assert.equal(eventBinding(key({ key: "k", code: "KeyK", metaKey: true })), "mod+k");
		assert.equal(eventBinding(key({ key: "?", code: "Slash", shiftKey: true })), "?");
		assert.equal(eventBinding(key({ key: "ArrowUp", code: "ArrowUp", altKey: true })), "alt+arrowup");
	});
});

describe("toggle-dictation is ⌥D", () => {
	it("alt+d fires dictation; mod+d fires nothing", () => {
		assert.equal(bindingForAction("toggle-dictation"), "alt+d");
		assert.equal(actionForBinding("alt+d"), "toggle-dictation");
		assert.equal(actionForBinding("mod+d") ?? null, null);
	});
});
