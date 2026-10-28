import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionForBinding,
	AURA2_VOICES,
	DEFAULT_VOICE,
	previewLine,
	questionSpeech,
	speakableText,
	splitForSpeak,
	takeSpeakable,
} from "../src/core/index.ts";

/**
 * Read-aloud pins (voice wave, owner 2026-10-28): every math span speaks as
 * "(equation)", fenced code as "(code)", inline code as text; the stream
 * never cuts inside an open construct; questions read text + context but
 * never options — predictions, ask, probe/recall; checks stay silent.
 */

describe("speakableText — markdown → speech", () => {
	it("all math (inline, display, legacy) becomes (equation)", () => {
		assert.equal(speakableText("The gradient $\\nabla f$ points up."), "The gradient (equation) points up.");
		assert.equal(speakableText("Sum:\n\n$$\na^2+b^2\n$$\n\nDone."), "Sum: (equation) Done.");
		assert.equal(speakableText("Legacy \\(x\\) and \\[y\\] math."), "Legacy (equation) and (equation) math.");
	});

	it("fenced code becomes (code); inline code reads as text", () => {
		assert.equal(speakableText("Run it:\n\n```py\nprint(1)\n```\n\nCall `f(x)` now."), "Run it: (code) Call f(x) now.");
	});

	it("markup never speaks: emphasis, links, headings, lists, images", () => {
		assert.equal(
			speakableText("## Why\n\nA **bold** [link](http://x) ![img](y.png)\n\n- one\n- two"),
			"Why. A bold link. one. two.",
		);
	});
});

describe("takeSpeakable — the streaming cut", () => {
	it("takes complete sentences and keeps the unfinished tail", () => {
		assert.deepEqual(takeSpeakable("One. Two is not do", 0), { text: "One.", next: 4 });
	});

	it("never cuts inside open math, then resumes once it closes", () => {
		const raw = "First. Then $x. y";
		const a = takeSpeakable(raw, 0);
		assert.deepEqual(a, { text: "First.", next: 6 });
		const b = takeSpeakable(raw + "$ ends. More", a.next);
		assert.equal(b.text, "Then (equation) ends.");
	});

	it("never cuts inside an open code fence", () => {
		assert.deepEqual(takeSpeakable("Intro.\n```js\nlet a = 1. b\n", 0), { text: "Intro.", next: 7 });
	});

	it("final takes the rest", () => {
		assert.deepEqual(takeSpeakable("no end yet", 0, true), { text: "no end yet.", next: 10 });
		assert.deepEqual(takeSpeakable("done", 4, true), { text: "", next: 4 });
	});
});

describe("questionSpeech — which dock questions speak", () => {
	const input = { question: "What happens to $x$?", details: "Think **carefully**", options: [{ label: "Secret option" }] };

	it("predictions read question + context, never options", () => {
		const line = questionSpeech("quiz", { ...input, type: "predict" });
		assert.equal(line, "What happens to (equation)? Think carefully.");
		assert.equal(questionSpeech("explain", { ...input, type: "predict" }), line);
		assert.ok(!line!.includes("Secret"));
	});

	it("checks (and untyped quiz/explain) stay silent", () => {
		assert.equal(questionSpeech("quiz", { ...input, type: "check" }), null);
		assert.equal(questionSpeech("explain", { question: "Q?" }), null);
	});

	it("ask, probe and recall speak", () => {
		assert.equal(questionSpeech("ask_user_question", { question: "Which one?" }), "Which one?");
		assert.equal(questionSpeech("probe", { question: "Probe?" }), "Probe?");
		assert.equal(questionSpeech("recall", { question: "Recall?" }), "Recall?");
	});
});

describe("voice catalog + plumbing", () => {
	it("41 Aura-2 English voices, Athena the default", () => {
		assert.equal(AURA2_VOICES.length, 41);
		assert.equal(DEFAULT_VOICE, "aura-2-athena-en");
		assert.ok(AURA2_VOICES.some((v) => v.id === DEFAULT_VOICE));
		assert.equal(previewLine(DEFAULT_VOICE), "Hi, I'm Athena. This is how I'll read your answers.");
	});

	it("splits long speech under Deepgram's per-message cap at sentence ends", () => {
		const parts = splitForSpeak("A sentence here. ".repeat(200), 1500);
		assert.ok(parts.length > 1);
		for (const p of parts) assert.ok(p.length <= 1500 && p.endsWith("."));
	});

	it("⌥S toggles read aloud", () => {
		assert.equal(actionForBinding("alt+s"), "toggle-voice");
	});
});

describe("voice wave 2 — speed + manual reading positions (owner 2026-10-28)", () => {
	it("speeds are 0.7–1.5× in 0.1 steps, 1× default, formatted with one decimal", async () => {
		const { VOICE_SPEEDS, DEFAULT_SPEED, formatSpeed } = await import("../src/core/index.ts");
		assert.deepEqual([...VOICE_SPEEDS], [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
		assert.equal(DEFAULT_SPEED, 1);
		assert.equal(formatSpeed(1), "1.0×");
		assert.equal(formatSpeed(1.3), "1.3×");
	});

	it("resumeOffset lands on the start of the word being heard", async () => {
		const { resumeOffset } = await import("../src/core/index.ts");
		const text = "alpha beta gamma delta";
		assert.equal(resumeOffset(text, 0), 0);
		assert.equal(resumeOffset(text, 0.5), text.indexOf("gamma")); // mid-"gamma"
		assert.equal(resumeOffset(text, 0.3), text.indexOf("beta"));
		assert.equal(resumeOffset(text, 1), text.indexOf("delta"));
	});

	it("sentenceStartBefore finds the clicked sentence's start", async () => {
		const { sentenceStartBefore } = await import("../src/core/index.ts");
		const text = "First one. Second (equation) here! Third? Yes.";
		assert.equal(sentenceStartBefore(text, 3), 0);
		assert.equal(sentenceStartBefore(text, text.indexOf("here")), text.indexOf("Second"));
		assert.equal(sentenceStartBefore(text, text.indexOf("Yes")), text.indexOf("Yes"));
	});
});

describe("voice wave 3 — the word highlight + word right-click (owner 2026-10-28)", () => {
	it("sentenceSpans: one sentence per chunk, offsets into the text, long ones split", async () => {
		const { sentenceSpans } = await import("../src/core/index.ts");
		const text = "First one. Second?  Third\nFourth";
		assert.deepEqual(
			sentenceSpans(text).map(({ start, end }) => text.slice(start, end)),
			["First one.", "Second?", "Third", "Fourth"],
		);
		const long = "word ".repeat(100).trim();
		const spans = sentenceSpans(long, 50);
		assert.ok(spans.length > 1 && spans.every((s) => s.end - s.start <= 50));
	});

	it("wordAtFraction: the word holding that share of the characters", async () => {
		const { wordAtFraction } = await import("../src/core/index.ts");
		assert.equal(wordAtFraction("one two three", 0), 0);
		assert.equal(wordAtFraction("one two three", 0.5), 1);
		assert.equal(wordAtFraction("one two three", 0.99), 2);
		assert.equal(wordAtFraction("", 0.5), -1);
	});

	it("matchWords: finds the spoken sentence among the screen words, case/punctuation-blind", async () => {
		const { matchWords } = await import("../src/core/index.ts");
		const screen = "Intro. The gradient (equation) points uphill. The gradient again.".split(" ");
		assert.equal(matchWords(screen, ["the", "gradient", "(equation)"]), 1);
		assert.equal(matchWords(screen, ["The", "gradient", "again."], 2), 6);
		assert.equal(matchWords(screen, ["nowhere", "to", "be"]), -1);
	});

	it("wordStartBefore: right-click starts at the clicked word", async () => {
		const { wordStartBefore } = await import("../src/core/index.ts");
		const text = "Read from this word please.";
		assert.equal(wordStartBefore(text, text.indexOf("word") + 2), text.indexOf("word"));
		assert.equal(wordStartBefore(text, 0), 0);
	});

	it("bare P pauses/resumes reading", () => {
		assert.equal(actionForBinding("p"), "toggle-voice-pause");
	});
});

describe("voice wave 4 — the reading cursor (owner 2026-10-28)", () => {
	// Three visual lines, 20px tall; line 1 holds TWO sentences ("A b. C d.").
	const boxes = [
		{ left: 0, right: 10, top: 0, bottom: 20 }, // 0 A
		{ left: 15, right: 25, top: 0, bottom: 20 }, // 1 b.
		{ left: 30, right: 40, top: 0, bottom: 20 }, // 2 C   ← next sentence, SAME line
		{ left: 45, right: 55, top: 0, bottom: 20 }, // 3 d.
		{ left: 0, right: 30, top: 24, bottom: 44 }, // 4 Eeee  (line 2)
		{ left: 35, right: 60, top: 24, bottom: 44 }, // 5 fff
		{ left: 0, right: 8, top: 48, bottom: 68 }, // 6 g     (line 3)
		{ left: 12, right: 40, top: 48, bottom: 68 }, // 7 hhhh
	];
	const box = (i: number) => boxes[i] ?? null;

	it("↓ goes to the next LINE, never to the next sentence on the same line", async () => {
		const { nextLineIndex } = await import("../src/core/index.ts");
		assert.equal(nextLineIndex(boxes.length, box, 1, 1, 20), 4); // b. (x≈20) → Eeee, not C
		assert.equal(nextLineIndex(boxes.length, box, 3, 1, 50), 5); // d. (x=50) → fff
	});

	it("↑ goes to the line above; no line = stay put", async () => {
		const { nextLineIndex } = await import("../src/core/index.ts");
		assert.equal(nextLineIndex(boxes.length, box, 5, -1, 47), 3);
		assert.equal(nextLineIndex(boxes.length, box, 2, -1, 35), 2);
		assert.equal(nextLineIndex(boxes.length, box, 7, 1, 26), 7);
	});

	it("the sticky column survives a short line (editor behavior)", async () => {
		const { nextLineIndex } = await import("../src/core/index.ts");
		// From fff (x≈47) down: line 3's nearest to 47 is hhhh.
		assert.equal(nextLineIndex(boxes.length, box, 5, 1, 47.5), 7);
	});

	it("only a clean single click places the cursor — never a selection gesture", async () => {
		const { isCursorClick } = await import("../src/core/index.ts");
		const clean = { button: 0, detail: 1, modifier: false, travel: 1, selectionCollapsed: true, interactive: false };
		assert.equal(isCursorClick(clean), true);
		assert.equal(isCursorClick({ ...clean, travel: 12 }), false); // a drag-select
		assert.equal(isCursorClick({ ...clean, detail: 2 }), false); // double-click selects a word
		assert.equal(isCursorClick({ ...clean, modifier: true }), false); // shift extends a selection
		assert.equal(isCursorClick({ ...clean, selectionCollapsed: false }), false);
		assert.equal(isCursorClick({ ...clean, interactive: true }), false); // links, buttons, figures
		assert.equal(isCursorClick({ ...clean, button: 2 }), false); // right-click reads instead
	});
});

describe("voice wave 4b — ⌥/⌘ cursor jumps (owner 2026-10-28, macOS-style)", () => {
	it("startsSentence: after a sentence end (quotes/parens allowed), or first", async () => {
		const { startsSentence } = await import("../src/core/index.ts");
		assert.equal(startsSentence(undefined), true);
		assert.equal(startsSentence("end."), true);
		assert.equal(startsSentence('said."'), true);
		assert.equal(startsSentence("(equation)"), false);
		assert.equal(startsSentence("mid"), false);
	});

	it("jumpToStart: ⌥← = this unit's start when mid-unit, else the previous; ⌥→ = the next", async () => {
		const { jumpToStart } = await import("../src/core/index.ts");
		//               0     1      2     3     4      5
		const starts = [true, false, false, true, false, false];
		assert.equal(jumpToStart(starts, 4, -1), 3); // mid-sentence → its start
		assert.equal(jumpToStart(starts, 3, -1), 0); // at a start → the previous one
		assert.equal(jumpToStart(starts, 0, -1), 0);
		assert.equal(jumpToStart(starts, 1, 1), 3);
		assert.equal(jumpToStart(starts, 3, 1), 5); // no next start → the last word
	});

	it("lineEdgeIndex: ⌘←/→ stop at the visual line's first/last word", async () => {
		const { lineEdgeIndex } = await import("../src/core/index.ts");
		const boxes = [
			{ left: 0, right: 10, top: 0, bottom: 20 },
			{ left: 15, right: 25, top: 0, bottom: 20 },
			{ left: 30, right: 40, top: 0, bottom: 20 },
			{ left: 0, right: 10, top: 24, bottom: 44 },
			{ left: 15, right: 25, top: 24, bottom: 44 },
		];
		const box = (i: number) => boxes[i] ?? null;
		assert.equal(lineEdgeIndex(boxes.length, box, 1, -1), 0);
		assert.equal(lineEdgeIndex(boxes.length, box, 1, 1), 2);
		assert.equal(lineEdgeIndex(boxes.length, box, 3, 1), 4);
		assert.equal(lineEdgeIndex(boxes.length, box, 3, -1), 3);
	});
});
