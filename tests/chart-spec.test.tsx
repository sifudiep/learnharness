import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { parseChartSpec, speakableText } from "../src/core/index.ts";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { passageSpeech } from "../components/voice-dom.ts";

/**
 * The ```chart fence (stock-chart wave, owner 2026-11-01): price action as
 * real candlesticks, never ASCII. The teacher writes data; a wrong candle
 * is a precise error, never a chart asserting a lie.
 */

const BAR = { t: "Mon", o: 205, h: 206, l: 201, c: 203 };

describe("parseChartSpec — data, validated", () => {
	it("a full spec parses with defaults filled in", () => {
		const r = parseChartSpec(
			JSON.stringify({
				title: "Daily",
				bars: [BAR, { t: "Tue", o: 203, h: 206, l: 202.5, c: 205 }],
				levels: [{ price: 212, label: "protected high", style: "dashed" }],
				marks: [{ t: "Mon", at: "low", text: "low 201" }],
				lines: [{ from: { t: "Tue", price: 202.5 }, to: { t: "Mon", price: 201 } }],
			}),
		);
		assert.ok(r.ok);
		if (!r.ok) return;
		assert.equal(r.spec.bars.length, 2);
		assert.deepEqual(r.spec.levels[0], { price: 212, label: "protected high", style: "dashed", tone: "neutral" });
		assert.deepEqual(r.spec.marks[0], { t: "Mon", at: "low", text: "low 201", tone: "accent" });
		assert.equal(r.spec.lines[0]!.from.t, "Mon", "line ends are put in time order");
	});

	it("inconsistent candles are precise errors", () => {
		const high = parseChartSpec(JSON.stringify({ bars: [{ ...BAR, h: 204 }] }));
		assert.equal(high.ok, false);
		assert.match(!high.ok ? high.error : "", /bar "Mon": high 204 is below its open\/close/);
		const low = parseChartSpec(JSON.stringify({ bars: [{ ...BAR, l: 204 }] }));
		assert.match(!low.ok ? low.error : "", /low 204 is above/);
	});

	it("references must name real bars; labels are unique", () => {
		assert.match((parseChartSpec(JSON.stringify({ bars: [BAR], marks: [{ t: "Fri" }] })) as { error: string }).error, /"Fri" is not a bar label/);
		assert.match((parseChartSpec(JSON.stringify({ bars: [BAR, BAR] })) as { error: string }).error, /used twice/);
		assert.match(
			(parseChartSpec(JSON.stringify({ bars: [BAR], lines: [{ from: { t: "Mon", price: 1 }, to: { t: "Mon", price: 2 } }] })) as { error: string }).error,
			/two different bars/,
		);
	});

	it("not JSON / no bars", () => {
		assert.match((parseChartSpec("{oops") as { error: string }).error, /not valid JSON/);
		assert.match((parseChartSpec("{}") as { error: string }).error, /bars/);
	});

	it("the prompt's own example is valid (the teacher copies it)", () => {
		const md = fs.readFileSync("src/agent/prompts/shared/40-formatting.md", "utf8");
		const block = /```chart\n([\s\S]*?)```/.exec(md)?.[1];
		assert.ok(block, "the formatting prompt carries a chart example");
		assert.equal(parseChartSpec(block!).ok, true);
	});
});

describe("the fence renders as a chart, read aloud as one word", () => {
	const md = "Here it is:\n\n```chart\n" + JSON.stringify({ bars: [BAR] }) + "\n```\n\nNext.";

	it("```chart routes to the chart renderer (not a code block)", () => {
		const html = renderToStaticMarkup(<MessageResponse>{md}</MessageResponse>);
		assert.match(html, /data-testid="md-chart"/);
		assert.doesNotMatch(html, /data-testid="md-code"/);
	});

	it("a bad spec shows the error box with the source", () => {
		const bad = "```chart\n" + JSON.stringify({ bars: [{ ...BAR, h: 1 }] }) + "\n```";
		const html = renderToStaticMarkup(<MessageResponse>{bad}</MessageResponse>);
		assert.match(html, /data-testid="md-chart-error"/);
	});

	it("auto-read and screen reading both say (chart)", () => {
		assert.equal(speakableText(md), "Here it is: (chart) Next.");
		const html = renderToStaticMarkup(<div className="p"><MessageResponse>{md}</MessageResponse></div>);
		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		assert.equal(passageSpeech(document.querySelector(".p")!).text.replace(/\s+/g, " ").trim(), "Here it is: (chart) Next.");
	});
});
