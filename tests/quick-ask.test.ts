import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseQuickAskRequest,
	QUICK_ASK_MAX_IMAGES,
	quickAskContext,
	quickAskUserText,
	type LhMessage,
} from "../src/core/index.ts";

/**
 * Quick ask (owner, 2026-11-04): side questions with compact session
 * context — summary + plan + recent turns (~3k tokens) + the open question.
 */

let n = 0;
const user = (text: string) => ({ id: `u${n++}`, role: "user", content: text, timestamp: n }) as unknown as LhMessage;
const teacher = (text: string, extra: unknown[] = []) =>
	({ id: `a${n++}`, role: "assistant", content: [{ type: "text", text }, ...extra], timestamp: n, api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop" }) as unknown as LhMessage;

describe("parseQuickAskRequest", () => {
	it("needs a question; trims and caps the rest", () => {
		assert.equal(parseQuickAskRequest({}).ok, false);
		const r = parseQuickAskRequest({ question: "  why?  ", marked: ["a", "", 3], thread: [{ question: "q", answer: "a" }, { bad: 1 }] });
		assert.ok(r.ok);
		if (!r.ok) return;
		assert.equal(r.req.question, "why?");
		assert.deepEqual(r.req.marked, ["a"]);
		assert.deepEqual(r.req.thread, [{ question: "q", answer: "a" }]);
	});

	it("screenshots: image types only, capped in count", () => {
		assert.equal(parseQuickAskRequest({ question: "q", images: [{ data: "x", mimeType: "text/html" }] }).ok, false);
		const many = Array.from({ length: QUICK_ASK_MAX_IMAGES + 1 }, () => ({ data: "x", mimeType: "image/png" }));
		assert.equal(parseQuickAskRequest({ question: "q", images: many }).ok, false);
		assert.equal(parseQuickAskRequest({ question: "q", images: [{ data: "x", mimeType: "image/png" }] }).ok, true);
	});
});

describe("quickAskContext — compact session context", () => {
	it("recent turns as plain Learner/Teacher text, plus the open question", () => {
		const question = { type: "toolCall", id: "call_q", name: "quiz", arguments: { type: "predict", question: "Where does the stop go?", options: [{ label: "a" }] } };
		const ctx = quickAskContext({
			title: "Swing trading",
			messages: [user("teach me stops"), teacher("A stop sits below the swing low.", [question])],
		});
		assert.match(ctx, /# Session: Swing trading/);
		assert.match(ctx, /teach me stops/);
		assert.match(ctx, /A stop sits below the swing low\./);
		assert.match(ctx, /The question the learner is answering right now\n\nWhere does the stop go\?/);
	});

	it("long sessions keep only the most recent ~budget, cut at a turn", () => {
		const msgs: LhMessage[] = [];
		for (let i = 0; i < 60; i++) msgs.push(user(`question ${i} ${"x".repeat(200)}`), teacher(`answer ${i} ${"y".repeat(200)}`));
		const ctx = quickAskContext({ messages: msgs }, 3000);
		assert.ok(ctx.length < 3600, `bounded (${ctx.length})`);
		assert.match(ctx, /earlier turns omitted/);
		assert.match(ctx, /answer 59/, "the newest turn is always in");
		assert.doesNotMatch(ctx, /question 0 /, "the oldest is gone");
	});
});

describe("quickAskUserText", () => {
	it("context, earlier thread, marked text, screenshots note, then the question", () => {
		const text = quickAskUserText("CTX", { question: "Why 62?", marked: ["the zone top"], images: [{ data: "x", mimeType: "image/png" }], thread: [{ question: "q1", answer: "a1" }] });
		const order = ["<session_context>", "<earlier_quick_questions>", "<marked_text>", "(1 screenshot attached)", "Question: Why 62?"].map((s) => text.indexOf(s));
		assert.ok(order.every((i) => i >= 0));
		assert.deepEqual([...order].sort((a, b) => a - b), order);
		assert.match(text, /\[1\] the zone top/);
	});
});
