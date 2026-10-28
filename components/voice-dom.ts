/**
 * Manual reading reads the RENDERED answer (voice wave 2, owner
 * 2026-10-28): ▶ and right-click start from what is on screen, so a
 * right-click maps to the exact sentence clicked. Rendered KaTeX speaks as
 * "(equation)", <pre> as "(code)"; images, svg, buttons and aria-hidden
 * chrome are skipped. Every text node (and every atomic placeholder)
 * records where it starts in the speech, so a caret position maps back.
 */

import { CODE_WORD, EQUATION_WORD } from "@/src/core";

export interface PassageSpeech {
	text: string;
	marks: { node: Node; start: number }[];
}

const SKIP = new Set(["IMG", "SVG", "BUTTON", "SCRIPT", "STYLE", "VIDEO", "CANVAS", "INPUT", "TEXTAREA"]);
const BLOCK = /^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|TR|DIV|UL|OL|TABLE|SECTION|FIGURE|DETAILS|SUMMARY)$/;

export function passageSpeech(root: Node): PassageSpeech {
	let text = "";
	const marks: PassageSpeech["marks"] = [];
	// A block ends: a pause mark when it has none (speakableText's rule).
	const endBlock = () => {
		const t = text.trimEnd();
		if (!t || /[.!?:;,)]$/.test(t)) {
			if (t && !text.endsWith(" ")) text += " ";
			return;
		}
		text = `${t}. `;
	};
	const walk = (n: Node) => {
		if (n.nodeType === 3) {
			marks.push({ node: n, start: text.length });
			text += n.nodeValue ?? "";
			return;
		}
		if (n.nodeType !== 1) return;
		const el = n as Element;
		const tag = el.tagName.toUpperCase();
		if (el.classList.contains("katex-display") || el.classList.contains("katex")) {
			marks.push({ node: el, start: text.length });
			text += ` ${EQUATION_WORD} `;
			return;
		}
		if (tag === "PRE") {
			endBlock();
			marks.push({ node: el, start: text.length });
			text += `${CODE_WORD} `;
			return;
		}
		if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "img") return;
		const block = BLOCK.test(tag);
		if (block) endBlock();
		for (const child of Array.from(el.childNodes)) walk(child);
		if (block) endBlock();
	};
	walk(root);
	endBlock();
	return { text, marks };
}

/** The speech offset of a caret (node, offset) inside the passage, or null
 *  when it lands in skipped chrome. Atomic placeholders (math, code) map
 *  to their own start wherever inside them the caret fell. */
export function speechOffsetOf(speech: PassageSpeech, node: Node, offset: number): number | null {
	for (let n: Node | null = node; n; n = n.parentNode) {
		const mark = speech.marks.find((m) => m.node === n);
		if (mark) return mark.start + (n === node && n.nodeType === 3 ? offset : 0);
	}
	return null;
}

/** Where speech offsets [start, end) sit in the DOM: a word inside one
 *  text node (offsets into it), or a whole atomic placeholder element
 *  (rendered math / code) — null when it falls outside any mark. */
export function wordSpot(speech: PassageSpeech, start: number, end: number): { node: Node; from?: number; to?: number } | null {
	let owner: PassageSpeech["marks"][number] | null = null;
	for (const m of speech.marks) {
		if (m.start > start) break;
		owner = m;
	}
	if (!owner) return null;
	if (owner.node.nodeType !== 3) return { node: owner.node };
	const len = (owner.node.nodeValue ?? "").length;
	const from = start - owner.start;
	if (from < 0 || from >= len) return null;
	return { node: owner.node, from, to: Math.min(len, end - owner.start) };
}

/** The highlight's DOM Range for speech offsets [start, end). */
export function rangeOf(speech: PassageSpeech, start: number, end: number): Range | null {
	const spot = wordSpot(speech, start, end);
	const doc = spot?.node.ownerDocument;
	if (!spot || !doc) return null;
	const range = doc.createRange();
	if (spot.from === undefined) range.selectNode(spot.node);
	else {
		range.setStart(spot.node, spot.from);
		range.setEnd(spot.node, spot.to!);
	}
	return range;
}
