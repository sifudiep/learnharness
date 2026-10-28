/**
 * Read-aloud (voice wave, owner 2026-10-28) — the PURE half: the Aura-2
 * voice catalog, markdown → speakable text, the streaming cut rule, and
 * which dock questions speak. Browser-safe, no React; the playback engine
 * lives in components/voice.tsx.
 *
 * Owner rulings carried in:
 *  - Deepgram Aura-2 on the existing DEEPGRAM_API_KEY (same token mint as
 *    dictation).
 *  - Every math span (inline AND display) speaks as "(equation)"; fenced
 *    code as "(code)"; inline code reads as plain text.
 *  - Questions speak their text + context line, NEVER the options —
 *    predictions, ask, probe/recall; checks stay silent.
 *  - Prefs (on/off + voice + speed) live on this device (localStorage `lh:voice`).
 *  - Speed (owner, 2026-10-28): 0.7×–1.5× in 0.1 steps — Deepgram's native
 *    `speed` param (pitch-preserving; 2× is rejected by the API).
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { readContentSpans } from "./content-reader.ts";
import { normalizeQuizType } from "./question-core.ts";

export interface AuraVoice {
	/** The Deepgram model id (the `model` query param). */
	id: string;
	name: string;
	accent: string;
	tags: readonly string[];
}

/** The Aura-2 English voices — Deepgram's /v1/models list, 2026-10-28. */
export const AURA2_VOICES: readonly AuraVoice[] = (
	[
		["amalthea", "Filipino", "feminine, engaging, natural, cheerful"],
		["andromeda", "American", "feminine, casual, expressive, comfortable"],
		["apollo", "American", "masculine, confident, comfortable, casual"],
		["arcas", "American", "masculine, natural, smooth, clear, comfortable"],
		["aries", "American", "masculine, warm, energetic, caring"],
		["asteria", "American", "feminine, clear, confident, knowledgeable, energetic"],
		["athena", "American", "feminine, calm, smooth, professional"],
		["atlas", "American", "masculine, enthusiastic, confident, approachable, friendly"],
		["aurora", "American", "feminine, cheerful, expressive, energetic"],
		["callista", "American", "feminine, clear, energetic, professional, smooth"],
		["cora", "American", "feminine, smooth, melodic, caring"],
		["cordelia", "American", "feminine, approachable, warm, polite"],
		["delia", "American", "feminine, casual, friendly, cheerful, breathy"],
		["draco", "British", "masculine, warm, approachable, trustworthy, baritone"],
		["electra", "American", "feminine, professional, engaging, knowledgeable"],
		["harmonia", "American", "feminine, empathetic, clear, calm, confident"],
		["helena", "American", "feminine, caring, natural, positive, friendly, raspy"],
		["hera", "American", "feminine, smooth, warm, professional"],
		["hermes", "American", "masculine, expressive, engaging, professional"],
		["hyperion", "Australian", "masculine, caring, warm, empathetic"],
		["iris", "American", "feminine, cheerful, positive, approachable"],
		["janus", "American", "feminine, southern, smooth, trustworthy"],
		["juno", "American", "feminine, natural, engaging, melodic, breathy"],
		["jupiter", "American", "masculine, expressive, knowledgeable, baritone"],
		["luna", "American", "feminine, friendly, natural, engaging"],
		["mars", "American", "masculine, smooth, patient, trustworthy, baritone"],
		["minerva", "American", "feminine, positive, friendly, natural"],
		["neptune", "American", "masculine, professional, patient, polite"],
		["odysseus", "American", "masculine, calm, smooth, comfortable, professional"],
		["ophelia", "American", "feminine, expressive, enthusiastic, cheerful"],
		["orion", "American", "masculine, approachable, comfortable, calm, polite"],
		["orpheus", "American", "masculine, professional, clear, confident, trustworthy"],
		["pandora", "British", "feminine, smooth, calm, melodic, breathy"],
		["phoebe", "American", "feminine, energetic, warm, casual"],
		["pluto", "American", "masculine, smooth, calm, empathetic, baritone"],
		["saturn", "American", "masculine, knowledgeable, confident, baritone"],
		["selene", "American", "feminine, expressive, engaging, energetic"],
		["thalia", "American", "feminine, clear, confident, energetic, enthusiastic"],
		["theia", "Australian", "feminine, expressive, polite, sincere"],
		["vesta", "American", "feminine, natural, expressive, patient, empathetic"],
		["zeus", "American", "masculine, deep, trustworthy, smooth"],
	] as const
).map(([slug, accent, tags]) => ({
	id: `aura-2-${slug}-en`,
	name: slug[0]!.toUpperCase() + slug.slice(1),
	accent,
	tags: tags.split(", "),
}));

export const DEFAULT_VOICE = "aura-2-athena-en";

export function voiceById(id: string): AuraVoice {
	return AURA2_VOICES.find((v) => v.id === id) ?? AURA2_VOICES.find((v) => v.id === DEFAULT_VOICE)!;
}

/** The Settings preview line (owner-approved wording). */
export function previewLine(voiceId: string): string {
	return `Hi, I'm ${voiceById(voiceId).name}. This is how I'll read your answers.`;
}

// ─── prefs (this device) ────────────────────────────────────────────────────

export const VOICE_SPEEDS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;
export const DEFAULT_SPEED = 1;

/** "1.2×" — the pill and the menus. */
export function formatSpeed(speed: number): string {
	return `${speed.toFixed(1)}×`;
}

export interface VoicePrefs {
	enabled: boolean;
	voice: string;
	speed: number;
}

const PREFS_KEY = "lh:voice";
/** Same-window change signal (the storage event only fires cross-window). */
export const VOICE_PREFS_EVENT = "lh:voice-prefs";

export function loadVoicePrefs(): VoicePrefs {
	const fallback: VoicePrefs = { enabled: false, voice: DEFAULT_VOICE, speed: DEFAULT_SPEED };
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(PREFS_KEY);
		if (!raw) return fallback;
		const p = JSON.parse(raw) as Partial<VoicePrefs>;
		return {
			enabled: p.enabled === true,
			voice: typeof p.voice === "string" && AURA2_VOICES.some((v) => v.id === p.voice) ? p.voice : DEFAULT_VOICE,
			speed: (VOICE_SPEEDS as readonly number[]).includes(p.speed as number) ? (p.speed as number) : DEFAULT_SPEED,
		};
	} catch {
		return fallback; // corrupt/unavailable store = defaults
	}
}

export function saveVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
	const next = { ...loadVoicePrefs(), ...patch };
	if (typeof window === "undefined") return next;
	try {
		window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
	} catch {
		/* storage unavailable = prefs don't persist */
	}
	window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT));
	return next;
}

// ─── markdown → speech ──────────────────────────────────────────────────────

export const EQUATION_WORD = "(equation)";
export const CODE_WORD = "(code)";

type MdNode = { type: string; value?: string; children?: MdNode[] };

const BLOCKS = new Set(["paragraph", "heading", "tableCell", "blockquote", "listItem", "list", "root", "table", "tableRow"]);

/** Plain speech for a markdown passage. Math spans go first (the rendering
 *  stack's own delimiter reader, legacy \( \[ included), then the
 *  CommonMark tree supplies the text — never the markup. */
export function speakableText(markdown: string): string {
	const replaced = readContentSpans(markdown)
		// A display block on its own lines keeps its surrounding blank lines
		// in the prose spans, so the word lands as its own block anyway.
		.map((s) => (s.kind === "math" ? EQUATION_WORD : s.raw))
		.join("");
	const blocks: string[] = [];
	let line = "";
	const endBlock = () => {
		const t = line.replace(/\s+/g, " ").trim();
		// A heading/list item without terminal punctuation still pauses.
		if (t) blocks.push(/[.!?:;,)]$/.test(t) ? t : `${t}.`);
		line = "";
	};
	const walk = (node: MdNode) => {
		switch (node.type) {
			case "code":
				endBlock();
				blocks.push(CODE_WORD);
				return;
			case "text":
			case "inlineCode":
				line += node.value ?? "";
				return;
			case "break":
				line += " ";
				return;
			case "image":
			case "html":
			case "thematicBreak":
			case "definition":
				return;
		}
		const block = BLOCKS.has(node.type) && node.type !== "list" && node.type !== "root" && node.type !== "table";
		if (block) endBlock();
		for (const child of node.children ?? []) walk(child);
		if (block) endBlock();
	};
	walk(fromMarkdown(replaced) as MdNode);
	endBlock();
	return blocks
		.join(" ")
		// GFM leftovers (no gfm parser here): table pipes/rules, stray markers.
		.replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, " ")
		.replace(/[|*~`]/g, " ")
		.replace(/\s+([.,!?;:])/g, "$1")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+$/, "")
		.trim();
}

/** True when a raw prefix leaves no construct open — an unclosed fence,
 *  math delimiter or inline-code tick would speak as garbage. */
function closedPrefix(raw: string): boolean {
	const fences = raw.match(/^[ \t]{0,3}(```|~~~)/gm)?.length ?? 0;
	if (fences % 2 === 1) return false;
	for (const span of readContentSpans(raw)) {
		if (span.kind !== "prose") continue;
		if (/(^|[^\\])(\$|\\\(|\\\[|`)/.test(span.raw)) return false;
	}
	return true;
}

/**
 * The streaming cut: from `from`, the longest run of COMPLETE sentences
 * (or lines) that leaves nothing open. `final` takes everything. Returns
 * the speech for that run and the new offset (unchanged = nothing yet).
 */
export function takeSpeakable(raw: string, from: number, final = false): { text: string; next: number } {
	if (from >= raw.length) return { text: "", next: from };
	const tail = raw.slice(from);
	if (final) return { text: speakableText(tail), next: raw.length };
	const cuts: number[] = [];
	const re = /[.!?](?=\s)|\n/g;
	for (let m = re.exec(tail); m; m = re.exec(tail)) cuts.push(m.index + m[0].length);
	for (let i = cuts.length - 1; i >= 0; i--) {
		const cut = cuts[i]!;
		if (closedPrefix(tail.slice(0, cut))) return { text: speakableText(tail.slice(0, cut)), next: from + cut };
	}
	return { text: "", next: from };
}

/** Deepgram's per-message text cap is 2000 chars — split long speech at
 *  sentence ends (a whole answer can land at once via the poll path). */
export function splitForSpeak(text: string, max = 1500): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > max) {
		const window = rest.slice(0, max);
		const end = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
		const cut = end > 0 ? end + 1 : (window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max);
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

/** What a pending dock question says aloud, or null when it stays silent:
 *  predictions (quiz/explain `type: predict`), ask, probe and recall —
 *  checks never. Question text, then the context line; never options. */
export function questionSpeech(tool: string, input: unknown): string | null {
	const i = (input ?? {}) as { question?: unknown; details?: unknown; type?: unknown };
	if (tool === "quiz" || tool === "explain") {
		if (normalizeQuizType(i.type) !== "predict") return null;
	} else if (tool !== "ask_user_question" && tool !== "probe" && tool !== "recall") return null;
	const parts = [i.question, i.details]
		.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		.map(speakableText)
		.filter(Boolean);
	return parts.length ? parts.join(" ") : null;
}

// ─── manual reading: positions ──────────────────────────────────────────────

/** The resume point for a chunk heard `fraction` of the way through: the
 *  start of the word at that character share (Deepgram's TTS stream gives
 *  no word timings — an estimate that lands on the word or one early). */
export function resumeOffset(text: string, fraction: number): number {
	const f = Math.max(0, Math.min(1, fraction));
	let i = Math.min(text.length, Math.floor(text.length * f));
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
	return i;
}

/** Where the sentence containing `offset` starts in plain (rendered) text:
 *  just after the previous sentence end (. ! ? + space) or block break. */
export function sentenceStartBefore(text: string, offset: number): number {
	const at = Math.max(0, Math.min(text.length, offset));
	const head = text.slice(0, at);
	const re = /[.!?]["')\]]*\s+|\n+/g;
	let start = 0;
	for (let m = re.exec(head); m; m = re.exec(head)) start = m.index + m[0].length;
	return start;
}

// ─── the word highlight (voice wave 3, owner 2026-10-28) ────────────────────
// Deepgram's TTS stream has no word timings: reading goes ONE SENTENCE per
// chunk and the highlighted word is the one at the share of the sentence's
// characters equal to the share of its audio played — drift stays within
// about a word.

/** The start of the word containing `offset` (right-click on a word). */
export function wordStartBefore(text: string, offset: number): number {
	let i = Math.max(0, Math.min(text.length, offset));
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
	return i;
}

/** Sentence spans in `text` (offsets into it), whitespace-trimmed; a span
 *  longer than `max` (Deepgram's per-message cap) breaks at its last space. */
export function sentenceSpans(text: string, max = 1500): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const push = (start: number, end: number) => {
		while (start < end && /\s/.test(text[start]!)) start++;
		while (end > start && /\s/.test(text[end - 1]!)) end--;
		while (end - start > max) {
			let cut = text.lastIndexOf(" ", start + max);
			if (cut <= start) cut = start + max;
			spans.push({ start, end: cut });
			start = cut;
			while (start < end && /\s/.test(text[start]!)) start++;
		}
		if (end > start) spans.push({ start, end });
	};
	const re = /[.!?]["')\]]*(?=\s)|\n/g;
	let from = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		push(from, m.index + m[0].length);
		from = m.index + m[0].length;
	}
	push(from, text.length);
	return spans;
}

/** Word tokens with their offsets. */
export function wordTokens(text: string): { start: number; end: number; word: string }[] {
	const out: { start: number; end: number; word: string }[] = [];
	for (const m of text.matchAll(/\S+/g)) out.push({ start: m.index!, end: m.index! + m[0].length, word: m[0] });
	return out;
}

/** Compare words loosely: case and punctuation never matter. */
export function normWord(word: string): string {
	return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Where a spoken sentence's words sit among the on-screen words (auto-read
 *  speaks the markdown source; the screen is the rendered answer): the
 *  index of the first screen word of the first match at or after `from`,
 *  on the sentence's first (up to) three comparable words — or -1. */
export function matchWords(screen: readonly string[], spoken: readonly string[], from = 0): number {
	const want = spoken.map(normWord).filter(Boolean).slice(0, 3);
	if (!want.length) return -1;
	const have = screen.map(normWord);
	for (let i = Math.max(0, from); i < have.length; i++) {
		if (have[i] !== want[0]) continue;
		let j = i, k = 0;
		while (k < want.length && j < have.length) {
			if (!have[j]) { j++; continue; }
			if (have[j] !== want[k]) break;
			j++; k++;
		}
		if (k === want.length) return i;
	}
	return -1;
}

/** The word index being heard at `fraction` of a sentence's audio — the
 *  word whose character span holds that share of the text. */
export function wordAtFraction(text: string, fraction: number): number {
	const tokens = wordTokens(text);
	if (!tokens.length) return -1;
	const at = Math.max(0, Math.min(1, fraction)) * text.length;
	const i = tokens.findIndex((t) => at < t.end);
	return i < 0 ? tokens.length - 1 : i;
}

// ─── the reading cursor (voice wave 4, owner 2026-10-28) ────────────────────

export interface WordBox {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * ↑/↓: the word on the NEXT VISUAL LINE (dir +1 below, -1 above) nearest
 * `goalX` — measured on screen, so a line holding several sentences never
 * jumps to the next sentence. `box(i)` measures word i lazily (null =
 * unmeasurable, skipped); the scan stops at the end of that line.
 * Returns `from` when there is no such line.
 */
export function nextLineIndex(
	count: number,
	box: (i: number) => WordBox | null,
	from: number,
	dir: 1 | -1,
	goalX: number,
): number {
	const cur = box(from);
	if (!cur) return from;
	let lineMid: number | null = null;
	let best = -1;
	let bestDist = Infinity;
	for (let i = from + dir; i >= 0 && i < count; i += dir) {
		const b = box(i);
		if (!b) continue;
		const mid = (b.top + b.bottom) / 2;
		if (lineMid === null) {
			// Still on the current line (or a wrapped piece of it): keep going.
			if (dir > 0 ? mid <= cur.bottom : mid >= cur.top) continue;
			lineMid = mid;
		} else if (Math.abs(mid - lineMid) > (b.bottom - b.top) / 2) break; // past that line
		const dist = Math.abs((b.left + b.right) / 2 - goalX);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best < 0 ? from : best;
}

/** A left click PLACES the reading cursor only when it is a clean single
 *  click — never a selection gesture: primary button, no modifier (shift
 *  extends selections), under 4px of travel, nothing selected afterwards,
 *  not a double/triple click, not on an interactive element. */
export function isCursorClick(c: {
	button: number;
	detail: number;
	modifier: boolean;
	travel: number;
	selectionCollapsed: boolean;
	interactive: boolean;
}): boolean {
	return c.button === 0 && c.detail === 1 && !c.modifier && c.travel < 4 && c.selectionCollapsed && !c.interactive;
}

// ─── cursor jumps (voice wave 4b, owner 2026-10-28 — macOS-style, scaled up
// one step: ⌥←/→ sentence, ⌥↑/↓ paragraph, ⌘←/→ line edge, ⌘↑/↓ answer edge)

/** Does a word start a sentence, given the word before it? (The rendered
 *  speech closes every block with a period, so blocks count too.) */
export function startsSentence(prev: string | undefined): boolean {
	return prev === undefined || /[.!?]["')\]]*$/.test(prev);
}

/**
 * Jump to a "start" (sentence or paragraph): backward = the current unit's
 * start when mid-unit, else the previous one's (macOS ⌥← on words);
 * forward = the next start. No such start: the first/last index.
 */
export function jumpToStart(starts: readonly boolean[], at: number, dir: 1 | -1): number {
	if (dir < 0) {
		for (let i = starts[at] ? at - 1 : at; i >= 0; i--) if (starts[i]) return i;
		return 0;
	}
	for (let i = at + 1; i < starts.length; i++) if (starts[i]) return i;
	return starts.length - 1;
}

/** ⌘←/→: the first/last word on the current VISUAL line (measured). */
export function lineEdgeIndex(count: number, box: (i: number) => WordBox | null, at: number, dir: 1 | -1): number {
	const cur = box(at);
	if (!cur) return at;
	const mid = (cur.top + cur.bottom) / 2;
	const half = (cur.bottom - cur.top) / 2;
	let edge = at;
	for (let i = at + dir; i >= 0 && i < count; i += dir) {
		const b = box(i);
		if (!b) continue;
		if (Math.abs((b.top + b.bottom) / 2 - mid) > half) break;
		edge = i;
	}
	return edge;
}
