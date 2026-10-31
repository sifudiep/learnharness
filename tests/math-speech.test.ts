import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import katex from "katex";
import { parseHTML } from "linkedom";
import { passageSpeech } from "../components/voice-dom.ts";
import {
	EQUATION_WORD, loadMathSpeech, mathFixups, mathSpeechReady, mathToSpeech, speakableText, wordTokens,
} from "../src/core/index.ts";

/**
 * Equations are spoken out (owner, 2026-10-31): speech-rule-engine in
 * ClearSpeak style, one converter for auto-read (markdown source) and
 * manual reading (rendered KaTeX). node:test runs each file in its own
 * process, so the engine starts unloaded here.
 */

function rendered(html: string): Element {
	const { document } = parseHTML(`<div class="lh-source-passage">${html}</div>`);
	return document.querySelector(".lh-source-passage")!;
}
const inline = (tex: string) => katex.renderToString(tex, { throwOnError: false });
const display = (tex: string) => katex.renderToString(tex, { throwOnError: false, displayMode: true });

describe("before the engine loads", () => {
	it("every path falls back to (equation)", () => {
		assert.equal(mathSpeechReady(), false);
		assert.equal(mathToSpeech("x^2"), EQUATION_WORD);
		assert.equal(speakableText("The square $x^2$ grows."), "The square (equation) grows.");
		assert.equal(passageSpeech(rendered(`<p>The square ${inline("x^2")} grows.</p>`)).text.replace(/\s+/g, " ").trim(), "The square (equation) grows.");
	});
});

describe("mathToSpeech — ClearSpeak", () => {
	before(async () => {
		await loadMathSpeech();
		assert.equal(mathSpeechReady(), true);
	});

	const cases: [string, string][] = [
		["x^2 + 1 = 0", "x squared plus 1 equals 0"],
		["\\frac{1}{3}", "one third"],
		["\\frac{a}{b}", "a over b"],
		["\\sqrt{2}", "the square root of 2"],
		["\\int_0^1 x\\,dx", "the integral from 0 to 1 of x d x"],
		["f'(x) = 3x^2", "f prime of x equals 3 x squared"],
		["\\sum_{n=1}^{\\infty} a_n", "the sum from n equals 1 to infinity of a sub n"],
		["x \\leq 3", "x is less than or equal to 3"],
		["\\mathbb{R}", "the real numbers"],
		["\\Omega", "Omega"],
	];
	for (const [tex, words] of cases) {
		it(`${tex} → ${words}`, () => assert.equal(mathToSpeech(tex), words));
	}

	it("upright symbols never speak their font (no \"normal infinity\")", () => {
		assert.equal(mathToSpeech("\\infty"), "infinity");
		assert.equal(mathToSpeech("\\mathrm{d}x"), "d x");
	});

	it("combining accents are dropped from the words", () => {
		assert.equal(mathToSpeech("\\vec{v}"), "v");
	});

	it("unreadable or empty TeX falls back to (equation)", () => {
		assert.equal(mathToSpeech("\\badcommand{x}"), EQUATION_WORD);
		assert.equal(mathToSpeech("  "), EQUATION_WORD);
	});
});

describe("fix-ups", () => {
	before(() => loadMathSpeech());

	it("implies, in all three spellings", () => {
		assert.equal(mathToSpeech("A \\land B \\implies C"), "A and B implies C");
		assert.equal(mathToSpeech("p \\Rightarrow q"), "p implies q");
		assert.equal(mathToSpeech("p \\Longrightarrow q"), "p implies q");
	});

	it("limits read as 'the limit as … approaches … of'", () => {
		assert.equal(mathToSpeech("\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1"), "the limit as x approaches 0 of sine x over x equals 1");
		assert.equal(mathToSpeech("\\lim_{n\\rightarrow\\infty} a_n"), "the limit as n approaches infinity of a sub n");
	});

	it("a bar inside P(…) reads 'given'; elsewhere the engine's reading stays", () => {
		assert.equal(mathToSpeech("P(A \\mid B)"), "P of open paren A given B close paren");
		assert.equal(mathToSpeech("\\Pr(X \\mid Y)"), "the probability of open paren X given Y close paren");
		assert.equal(
			mathToSpeech("P(A|B) = \\frac{P(B|A)P(A)}{P(B)}"),
			"P of open paren A given B close paren equals P of open paren B given A close paren P of A over P of B",
		);
		assert.equal(mathToSpeech("a \\mid b"), "a divides b");
		assert.equal(mathToSpeech("|x|"), "the absolute value of x");
	});

	it("Delta is Delta, not the triangle glyph", () => {
		assert.equal(mathToSpeech("\\Delta x"), "Delta x");
	});

	it("fix-ups leave other TeX untouched", () => {
		assert.equal(mathFixups("\\Deltax + \\impliesx + Q(a|b)"), "\\Deltax + \\impliesx + Q(a|b)");
	});
});

describe("both reading paths speak the same words", () => {
	before(() => loadMathSpeech());

	it("auto-read (markdown) speaks inline, display and legacy math", () => {
		assert.equal(speakableText("The square $x^2$ grows."), "The square x squared grows.");
		assert.equal(speakableText("Sum:\n\n$$\na^2+b^2\n$$\n\nDone."), "Sum: a squared plus b squared. Done.");
		assert.equal(speakableText("Legacy \\(x\\) and \\[y\\] math."), "Legacy x and y math.");
	});

	it("spoken math is never parsed as markdown", () => {
		// Raw, the asterisks would be markdown emphasis; spoken, they are words.
		assert.equal(speakableText("Then $a * b * c$ ends."), "Then a asterisk b asterisk c ends.");
	});

	it("manual reading (rendered KaTeX) matches auto-read word for word", () => {
		const md = "Since $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$ we get\n\n$$\nA \\implies B\n$$\n\nand $P(A \\mid B)$.";
		const html =
			`<p>Since ${inline("\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1")} we get</p>` +
			display("A \\implies B") +
			`<p>and ${inline("P(A \\mid B)")}.</p>`;
		const words = (t: string) => wordTokens(t).map((w) => w.word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean);
		assert.deepEqual(words(passageSpeech(rendered(html)).text), words(speakableText(md)));
	});

	it("rendered math without its TeX annotation still falls back", () => {
		const el = rendered('<p>See <span class="katex"><span>x</span></span> now.</p>');
		assert.equal(passageSpeech(el).text.replace(/\s+/g, " ").trim(), "See (equation) now.");
	});
});
