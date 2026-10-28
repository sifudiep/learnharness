import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { passageSpeech, speechOffsetOf } from "../components/voice-dom.ts";
import { sentenceStartBefore } from "../src/core/index.ts";

/**
 * Manual reading reads the RENDERED answer (voice wave 2, owner
 * 2026-10-28): KaTeX → "(equation)", <pre> → "(code)", chrome skipped, and
 * a right-click caret maps back to the clicked sentence.
 */

function passage(html: string): Element {
	const { document } = parseHTML(`<div class="lh-source-passage">${html}</div>`);
	return document.querySelector(".lh-source-passage")!;
}

describe("passageSpeech — rendered prose → speech", () => {
	it("math, code and chrome", () => {
		const el = passage(
			'<p>The slope <span class="katex"><span aria-hidden="true">x²</span></span> grows.</p>' +
				"<pre><code>print(1)</code></pre>" +
				'<h2>Next step</h2><p>Click <button>copy</button> done<img alt="a"></p>',
		);
		assert.equal(passageSpeech(el).text.replace(/\s+/g, " ").trim(), "The slope (equation) grows. (code) Next step. Click done.");
	});

	it("display math speaks once", () => {
		const el = passage('<p>Sum:</p><span class="katex-display"><span class="katex">a+b</span></span><p>End.</p>');
		assert.equal(passageSpeech(el).text.replace(/\s+/g, " ").trim(), "Sum: (equation) End.");
	});
});

describe("speechOffsetOf — the right-click caret → the sentence", () => {
	it("a caret in the second sentence starts reading there", () => {
		const el = passage("<p>One thing. Then <strong>another thing</strong> follows.</p>");
		const speech = passageSpeech(el);
		const strongText = el.querySelector("strong")!.firstChild!;
		const at = speechOffsetOf(speech, strongText, 3);
		assert.notEqual(at, null);
		assert.equal(speech.text.slice(sentenceStartBefore(speech.text, at!)).trim(), "Then another thing follows.");
	});

	it("a caret inside rendered math maps to the equation's place", () => {
		const el = passage('<p>Look. See <span class="katex"><span>x</span></span> now.</p>');
		const speech = passageSpeech(el);
		const inner = el.querySelector(".katex span")!.firstChild!;
		const at = speechOffsetOf(speech, inner, 0)!;
		assert.equal(speech.text.slice(sentenceStartBefore(speech.text, at)).replace(/\s+/g, " ").trim(), "See (equation) now.");
	});
});

describe("wordSpot — the highlighted word on screen", () => {
	it("a word inside a text node", async () => {
		const { wordSpot } = await import("../components/voice-dom.ts");
		const el = passage("<p>Alpha <em>beta</em> gamma.</p>");
		const speech = passageSpeech(el);
		const start = speech.text.indexOf("beta");
		assert.deepEqual(wordSpot(speech, start, start + 4), { node: el.querySelector("em")!.firstChild, from: 0, to: 4 });
	});

	it("the (equation) word highlights the whole rendered math", async () => {
		const { wordSpot } = await import("../components/voice-dom.ts");
		const el = passage('<p>See <span class="katex"><span>x</span></span> now.</p>');
		const speech = passageSpeech(el);
		const start = speech.text.indexOf("(equation)");
		assert.deepEqual(wordSpot(speech, start, start + 10), { node: el.querySelector(".katex") });
	});
});
