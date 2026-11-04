import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	chartDrawingsMarker,
	chartKey,
	DEFAULT_FIB_STYLE,
	describeDrawing,
	fibLevelPrice,
	inputAppends,
	nativeInputCause,
	parseDrawingsPut,
	sanitizeDrawings,
	type ChartDrawingsMap,
	type Drawing,
	type LhMessage,
} from "../src/core/index.ts";

/**
 * Learner chart drawings (owner, 2026-11-04): saved with the chat, shown to
 * the teacher as a summary on the next turn — only what changed.
 */

const labels = ["W1", "W2", "W3", "W4", "W5", "W6"];
const fib: Drawing = { id: "f1", kind: "fib", a: { bar: 2, price: 61 }, b: { bar: 5, price: 70 }, style: DEFAULT_FIB_STYLE };
const rect: Drawing = { id: "r1", kind: "rect", a: { bar: 5, price: 62 }, b: { bar: 2, price: 60 }, color: "yellow", text: "demand zone" };

describe("fib + the owner's TradingView template", () => {
	it("level 0 at B, 1 at A (TradingView's convention); reverse swaps", () => {
		assert.equal(fibLevelPrice(fib.a, fib.b, 0), 70);
		assert.equal(fibLevelPrice(fib.a, fib.b, 1), 61);
		assert.equal(Number(fibLevelPrice(fib.a, fib.b, 0.618).toFixed(3)), 64.438);
		assert.equal(fibLevelPrice(fib.a, fib.b, 0, true), 61);
	});

	it("default levels on = 0, 0.618, 0.786, 0.826, 1; dashed trend line, nothing else", () => {
		assert.deepEqual(DEFAULT_FIB_STYLE.levels.filter((l) => l.on).map((l) => l.value).sort(), [0, 0.618, 0.786, 0.826, 1]);
		assert.equal(DEFAULT_FIB_STYLE.trendLine, true);
		assert.equal(DEFAULT_FIB_STYLE.background || DEFAULT_FIB_STYLE.reverse || DEFAULT_FIB_STYLE.prices || DEFAULT_FIB_STYLE.levelLabels, false);
		assert.ok(DEFAULT_FIB_STYLE.levels.some((l) => l.value === 1.618 && !l.on), "extensions exist, off");
	});
});

describe("validation + summaries", () => {
	it("chartKey is stable and shaped; the PUT body is validated", () => {
		assert.match(chartKey('{"bars":[]}'), /^c[0-9a-f]{8}$/);
		assert.equal(chartKey(" x "), chartKey("x"));
		assert.equal(parseDrawingsPut({ key: "nope" }).ok, false);
		const ok = parseDrawingsPut({ key: chartKey("x"), labels, drawings: [fib, { id: "bad", kind: "rect" }] });
		assert.ok(ok.ok && ok.entry.drawings.length === 1, "an unknown/broken shape is dropped");
	});

	it("sanitize keeps palette colors and drops junk", () => {
		const out = sanitizeDrawings([{ id: "h", kind: "hline", price: 59.5, color: "pink", name: "stop" }, { kind: "trend" }]);
		assert.deepEqual(out, [{ id: "h", kind: "hline", price: 59.5, color: "yellow", dashed: false, name: "stop" }]);
	});

	it("describes drawings in bar labels and prices", () => {
		assert.equal(describeDrawing(rect, labels), 'rectangle "demand zone" (yellow) 60–62 over W3–W6');
		assert.match(describeDrawing(fib, labels), /^fib retracement from W3 61 to W6 70 — 0 → 70, 0\.618 → 64\.44, 0\.786 → 62\.93, 0\.826 → 62\.57, 1 → 61$/);
		assert.equal(describeDrawing({ id: "t", kind: "trend", a: { bar: 2, price: 61 }, b: { bar: 7.2, price: 66 }, color: "green", name: "higher lows" }, labels), 'trend line "higher lows" (green) from W3 61 to W6+2 66');
	});
});

describe("the next-turn marker — only what changed", () => {
	const key = chartKey("chart-a");
	const map = (drawings: Drawing[]): ChartDrawingsMap => ({ [key]: { title: "Zone", labels, drawings } });

	it("nothing drawn → no marker; first share → a marker with the summary", () => {
		assert.equal(chartDrawingsMarker({ messages: [] }, "m0"), null);
		const m = chartDrawingsMarker({ messages: [], chartDrawings: map([fib, rect]) }, "m1")!;
		assert.equal(m.customType, "chart-drawings");
		assert.match(m.content, /^\[Learner's chart drawings/);
		assert.match(m.content, /On "Zone":\n- fib retracement/);
		assert.equal((m.details as { count: number }).count, 2);
	});

	it("unchanged after sharing → nothing; changed → shared again; cleared → said", () => {
		const first = chartDrawingsMarker({ messages: [], chartDrawings: map([fib]) }, "m1")!;
		const history = [first as unknown as LhMessage];
		assert.equal(chartDrawingsMarker({ messages: history, chartDrawings: map([fib]) }, "m2"), null);
		assert.ok(chartDrawingsMarker({ messages: history, chartDrawings: map([fib, rect]) }, "m3"));
		assert.match(chartDrawingsMarker({ messages: history, chartDrawings: map([]) }, "m4")!.content, /removed all their drawings/);
	});

	it("rides AFTER the learner's text; counts as a neutral (not background) message", () => {
		const appends = inputAppends({ messages: [], chartDrawings: map([fib]) }, { type: "text", text: "look at my fib" });
		assert.deepEqual(appends.map((m) => (m as { role: string }).role), ["user", "custom"]);
		assert.equal(nativeInputCause(appends[1] as never, []), "neutral");
	});
});

describe("answers: the drawings ride AFTER the tool result, never between siblings", () => {
	const key = chartKey("chart-b");
	const chartDrawings: ChartDrawingsMap = { [key]: { title: "B", labels, drawings: [fib] } };
	const call = (id: string) => ({ type: "toolCall", id, name: "ask_user_question", arguments: { question: `Q ${id}?` } });
	const assistant = (...calls: unknown[]) =>
		({ id: `a_${calls.length}`, role: "assistant", content: calls, api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 1 }) as unknown as LhMessage;
	const answer = { kind: "ask", questionText: "Q", dontKnow: false, answers: [], text: "mine", answeredAt: "now" };

	it("a single question: [toolResult, marker]", () => {
		const appends = inputAppends({ messages: [assistant(call("q1"))], chartDrawings }, { type: "answer", toolCallId: "q1", answer } as never);
		assert.deepEqual(appends.map((m) => (m as { role: string }).role), ["toolResult", "custom"]);
	});

	it("a sibling question still waiting: no marker yet (it rides the last answer)", () => {
		const appends = inputAppends({ messages: [assistant(call("q1"), call("q2"))], chartDrawings }, { type: "answer", toolCallId: "q1", answer } as never);
		assert.deepEqual(appends.map((m) => (m as { role: string }).role), ["toolResult"]);
	});
});

describe("the transcript shows a chip, never the summary as learner words", () => {
	it("projects to a data-chart-drawings part", async () => {
		const { projectView } = await import("../src/core/index.ts");
		const marker = chartDrawingsMarker({ messages: [], chartDrawings: { [chartKey("c")]: { labels, drawings: [fib, rect] } } }, "m9")!;
		const view = projectView([marker as unknown as LhMessage] as never) as unknown as { parts: { type: string; data?: { count?: number } }[] }[];
		const part = view.flatMap((m) => m.parts).find((p) => p.type === "data-chart-drawings");
		assert.equal(part?.data?.count, 2);
		assert.ok(!view.flatMap((m) => m.parts).some((p) => p.type === "text"), "no text part");
	});
});
