import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionForBinding, evaluateCalc, formatCalc, previewCalc } from "../src/core/index.ts";

/** The chat calculator's arithmetic (owner, 2026-11-02): a parser, never eval. */

const v = (s: string) => {
	const r = evaluateCalc(s);
	assert.ok(r.ok, `${s} → ${!r.ok ? r.error : ""}`);
	return r.ok ? r.value : NaN;
};

describe("evaluateCalc", () => {
	it("precedence, parentheses, unary minus, symbols", () => {
		assert.equal(v("2 + 3 × 4"), 14);
		assert.equal(v("(2 + 3) * 4"), 20);
		assert.equal(v("-3 + 5"), 2);
		assert.equal(v("10 ÷ 4"), 2.5);
		assert.equal(v("8 − 2 − 1"), 5);
		assert.equal(v("50,000 * 1%"), 500);
	});

	it("percent: ± is a percent OF the left side; × ÷ a hundredth", () => {
		assert.equal(v("200 + 10%"), 220);
		assert.equal(v("200 - 10%"), 180);
		assert.equal(v("200 * 10%"), 20);
		assert.equal(v("10%"), 0.1);
	});

	it("swing-trade sizing: (account × risk) ÷ (entry − stop)", () => {
		assert.equal(Math.floor(v("50000 * 1% / (88.50 - 80)")), 58);
	});

	it("float noise is rounded away", () => {
		assert.equal(v("0.1 + 0.2"), 0.3);
	});

	it("errors are messages, never throws", () => {
		assert.deepEqual(evaluateCalc("5 / 0"), { ok: false, error: "Can't divide by 0" });
		assert.equal(evaluateCalc("(2 + 3").ok, false);
		assert.equal(evaluateCalc("2 +").ok, false);
		assert.equal(evaluateCalc("2 $ 3").ok, false);
		assert.equal(evaluateCalc("1.2.3").ok, false);
		assert.equal(evaluateCalc("").ok, false);
	});
});

describe("display", () => {
	it("formatCalc groups thousands and rounds to 2 decimals", () => {
		assert.equal(formatCalc(1234567.5), "1,234,567.5");
		assert.equal(formatCalc(58), "58");
		assert.equal(formatCalc(58.8235294118), "58.82");
		assert.equal(formatCalc(0.005), "0.01");
	});

	it("previewCalc ignores a dangling operator or open paren", () => {
		assert.equal(previewCalc("12 × 3 +"), "36");
		assert.equal(previewCalc("(2 + 3"), "5");
		assert.equal(previewCalc("+"), null);
	});

	it("⌥C toggles the calculator", () => {
		assert.equal(actionForBinding("alt+c"), "toggle-calculator");
	});
});
