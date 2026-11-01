import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * Answer drafts survive a reload (owner, 2026-11-01): the dock's form is
 * mirrored to localStorage PER CHAT, restored only onto the SAME question,
 * cleared by "Submit answer"; a closing tab mid-dictation saves the words.
 */

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
};
Object.assign(dom.window, { localStorage });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { clearAnswerDraft, loadAnswerDraft, saveAnswerDraft } = await import("../components/answer-draft-store.ts");
const { QuestionDock } = await import("../components/question-dock.tsx");
const { DICTATION_UNLOAD_EVENT } = await import("../components/dictation.tsx");
type Form = Parameters<typeof saveAnswerDraft>[2]["form"] & object;

const form = (over: Partial<Form> = {}): Form => ({
	selection: { selected: new Set([1]), otherSelected: false, dontKnow: false },
	thinking: "because the low held",
	other: "",
	text: "",
	confidenceIndex: 3,
	...over,
});

test("store: per chat, per question, merged, cleared", () => {
	store.clear();
	saveAnswerDraft("chat_a", "call_1", { form: form() });
	saveAnswerDraft("chat_a", "call_1", { readingThinking: "noticed the gap" });
	saveAnswerDraft("chat_b", "call_9", { form: form({ thinking: "other chat" }) });
	const a = loadAnswerDraft("chat_a", "call_1")!;
	assert.deepEqual([...a.form!.selection.selected], [1], "the Set round-trips");
	assert.equal(a.form!.thinking, "because the low held");
	assert.equal(a.readingThinking, "noticed the gap", "patches merge");
	assert.equal(loadAnswerDraft("chat_b", "call_9")!.form!.thinking, "other chat", "chats never share");
	assert.equal(loadAnswerDraft("chat_a", "call_2"), undefined, "never restored onto another question");
	saveAnswerDraft("chat_a", "call_2", { form: form({ thinking: "new q" }) });
	assert.equal(loadAnswerDraft("chat_a", "call_2")!.readingThinking, undefined, "a new question replaces the old draft");
	clearAnswerDraft("chat_a");
	assert.equal(loadAnswerDraft("chat_a", "call_2"), undefined);
	assert.ok(loadAnswerDraft("chat_b", "call_9"), "clearing one chat leaves the others");
});

test("store: a corrupt entry is no draft, never a crash", () => {
	store.set("lh:answer-draft:chat_x", "{not json");
	assert.equal(loadAnswerDraft("chat_x", "call_1"), undefined);
});

const input = { question: "Which low launched the move?", options: [{ label: "Mon" }, { label: "Fri" }] };

async function mount(props: Record<string, unknown>) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<QuestionDock toolName="ask_user_question" toolCallId="call_1" input={input} expanded dictationClaim={false}
				onExpand={() => {}} onSubmit={() => {}} {...props} />,
		),
	);
	return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("dock: an untouched mount stays quiet; edits and a restored draft report", async () => {
	const seen: Form[] = [];
	const quiet = await mount({ onDraftChange: (f: Form) => seen.push(f) });
	assert.equal(seen.length, 0, "an empty first mount must not overwrite a stored draft");
	const option = [...quiet.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')][0]!;
	await act(async () => option.click());
	assert.equal(seen.length, 1);
	assert.deepEqual([...seen[0]!.selection.selected], [0]);
	await quiet.unmount();

	const restored: Form[] = [];
	const r = await mount({ initialDraft: form({ selection: { selected: new Set([1]), otherSelected: false, dontKnow: false } }), onDraftChange: (f: Form) => restored.push(f) });
	assert.equal(restored.length, 1, "a restored draft re-saves at mount");
	assert.equal(restored[0]!.thinking, "because the low held");
	await r.unmount();
});

test("dock: a closing tab's dictation flush saves the draft synchronously", async () => {
	const seen: Form[] = [];
	const d = await mount({ onDraftChange: (f: Form) => seen.push(f) });
	window.dispatchEvent(new window.Event(DICTATION_UNLOAD_EVENT));
	assert.equal(seen.length, 1, "saved on the flush event, no render needed");
	await d.unmount();
});

test("dock: StrictMode's double mount never saves an empty form over a stored draft", async () => {
	const seen: Form[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<React.StrictMode>
				<QuestionDock toolName="ask_user_question" toolCallId="call_1" input={input} expanded dictationClaim={false}
					onExpand={() => {}} onSubmit={() => {}} onDraftChange={(f: Form) => seen.push(f)} />
			</React.StrictMode>,
		),
	);
	assert.equal(seen.length, 0);
	await act(async () => root.unmount());
	host.remove();
});
