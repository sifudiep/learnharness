"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import {
	DEFAULT_SPEED,
	DEFAULT_VOICE,
	formatSpeed,
	wordStartBefore,
	VOICE_SPEEDS,
	kbdEventForAction,
	loadVoicePrefs,
	questionSpeech,
	isTypingSurface,
	jumpToStart,
	lineEdgeIndex,
	startsSentence,
	matchWords,
	nextLineIndex,
	type WordBox,
	isCursorClick,
	resumeOffset,
	sentenceSpans,
	wordAtFraction,
	wordTokens,
	saveVoicePrefs,
	takeSpeakable,
	VOICE_PREFS_EVENT,
	type LhViewMessage,
	type VoicePrefs,
} from "@/src/core";
import { DeepgramKeylessError, warmTokens } from "@/components/deepgram-token";
import { DEEPGRAM_KEY_ID } from "@/components/dictation";
import { passageSpeech, rangeOf, speechOffsetOf, wordSpot } from "@/components/voice-dom";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

/**
 * Read-aloud — the playback half (voice wave, owner 2026-10-28; the pure
 * half is src/core/voice.ts).
 *
 * Architecture (dictation's mirror): the renderer opens Deepgram's TTS
 * WebSocket DIRECTLY with the shared short-lived token
 * (components/deepgram-token.ts) — one socket per turn, each speakable
 * chunk sent as Speak + Flush, `Close` at the turn's end (Deepgram
 * finishes the audio, then closes). linear16 @ 24kHz frames schedule
 * back-to-back on one app-lifetime AudioContext.
 *
 * Owner rulings: streams sentence by sentence; only text that arrives
 * AFTER voice is on speaks (history never auto-reads); Esc, starting
 * dictation, sending/answering and toggling off all cut the current
 * speech. On/off + voice live on this device (src/core/voice.ts prefs).
 */

export const VOICE_KEYLESS = "Voice needs a Deepgram key";
const SAMPLE_RATE = 24000;

// ─── the engine (module-level: one window, one voice) ──────────────────────
//
// A queue of CHUNKS (text + the answer it belongs to). One chunk is in
// generation at a time: Speak + Flush, and Deepgram's `Flushed` marks its
// audio complete — so every chunk knows when its audio starts and ends on
// the AudioContext clock. That timeline powers the speed restart (resume
// at the heard word), the "which answer is playing" state (the ▶/■), and
// the green word highlight (voice wave 3: one SENTENCE per chunk, the word
// estimated from the audio share played — Deepgram gives no timings).

let ctx: AudioContext | null = null;
let nextTime = 0;
const sources = new Set<AudioBufferSourceNode>();

/** Where a chunk sits on screen: `part` is the passage's data-voice-part;
 *  `domStart` its offset in that passage's speech (manual reading knows
 *  it), or undefined = find it by matching words (auto-read). `base` caches
 *  the resolved first screen-word index (-1 = not found: no highlight). */
type Anchor = { part: string; domStart?: number; base?: number };
type Chunk = {
	text: string;
	answerId: string | null;
	anchor: Anchor | null;
	sent: boolean;
	flushed: boolean;
	start: number | null;
	end: number;
};
type Sock = { ws: WebSocket | null; dropped: boolean; carry: number | null };
/** Every chunk not yet fully heard, in speaking order. */
let queue: Chunk[] = [];
/** The open (or opening) socket — null = open one when there is text. */
let sock: Sock | null = null;
/** No more text is coming for now (turn ended / manual read queued):
 *  Close the socket once everything is generated. */
let ending = false;
/** P paused the AudioContext (owner, 2026-10-28) — playback frozen mid-word. */
let paused = false;
let reportError: ((msg: string) => void) | null = null;

function audio(): AudioContext {
	if (!ctx) ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
	if (ctx.state === "suspended" && !paused) void ctx.resume().catch(() => {});
	return ctx;
}

/** Create/resume the context under a user gesture (autoplay policy). */
export function unlockAudio(): void {
	audio();
}

function play(s: Sock, data: ArrayBuffer): void {
	const chunk = queue.find((c) => c.sent && !c.flushed);
	let bytes = new Uint8Array(data);
	if (s.carry !== null) {
		const joined = new Uint8Array(bytes.length + 1);
		joined[0] = s.carry;
		joined.set(bytes, 1);
		bytes = joined;
		s.carry = null;
	}
	if (bytes.length % 2 === 1) {
		s.carry = bytes[bytes.length - 1]!;
		bytes = bytes.subarray(0, bytes.length - 1);
	}
	if (!bytes.length) return;
	const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
	const c = audio();
	const buf = c.createBuffer(1, pcm.length, SAMPLE_RATE);
	const ch = buf.getChannelData(0);
	for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
	const src = c.createBufferSource();
	src.buffer = buf;
	src.connect(c.destination);
	const at = Math.max(nextTime, c.currentTime + 0.03);
	src.start(at);
	nextTime = at + buf.duration;
	if (chunk) {
		chunk.start ??= at;
		chunk.end = nextTime;
	}
	sources.add(src);
	src.onended = () => {
		sources.delete(src);
		emit();
	};
	emit();
}

/** Drop chunks whose audio is fully heard. */
function prune(): void {
	const now = ctx?.currentTime ?? 0;
	queue = queue.filter((c) => !(c.flushed && (c.start === null || c.end <= now)));
}

function open(): Sock {
	const s: Sock = { ws: null, dropped: false, carry: null };
	const { voice, speed } = loadVoicePrefs();
	warmTokens
		.mint()
		.then((token) => {
			if (s.dropped) return;
			const ws = new WebSocket(
				`wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=linear16&sample_rate=${SAMPLE_RATE}&speed=${speed}`,
				["bearer", token],
			);
			ws.binaryType = "arraybuffer";
			s.ws = ws;
			ws.onopen = () => (s.dropped ? ws.close() : pump());
			ws.onmessage = (e) => {
				if (s.dropped) return;
				if (typeof e.data !== "string") return play(s, e.data as ArrayBuffer);
				if ((JSON.parse(e.data) as { type?: string }).type === "Flushed") {
					const chunk = queue.find((c) => c.sent && !c.flushed);
					if (chunk) chunk.flushed = true;
					pump();
				}
			};
			ws.onclose = (e) => {
				if (sock === s) sock = null;
				if (s.dropped) return;
				if (e.code !== 1000) {
					reportError?.(`Voice connection lost (${e.code})`);
					return stopVoice();
				}
				// A clean close with text still owed (an idle timeout mid-turn):
				// re-send what never finished on a fresh socket.
				for (const c of queue) if (!c.flushed) c.sent = false;
				pump();
			};
		})
		.catch((e: unknown) => {
			if (sock === s) sock = null;
			if (s.dropped) return;
			reportError?.(e instanceof DeepgramKeylessError ? VOICE_KEYLESS : e instanceof Error ? e.message : "token unavailable");
			stopVoice();
		});
	return s;
}

/** Advance: send the next chunk once the previous finished generating;
 *  Close the socket when nothing is owed and no more is coming. */
function pump(): void {
	prune();
	const generating = queue.some((c) => c.sent && !c.flushed);
	const next = queue.find((c) => !c.sent);
	if (!next) {
		if (ending && !generating && sock?.ws?.readyState === WebSocket.OPEN) {
			sock.ws.send(JSON.stringify({ type: "Close" }));
			sock = null;
			ending = false;
		}
		return emit();
	}
	sock ??= open();
	const ws = sock.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN || generating) return emit();
	next.sent = true;
	ws.send(JSON.stringify({ type: "Speak", text: next.text }));
	ws.send(JSON.stringify({ type: "Flush" }));
	emit();
}

/** Queue speech, one sentence per chunk. `answerId` tags the ▶/■ state;
 *  `part` + `domBase` anchor the highlight (domBase = this text's offset in
 *  the passage's speech; omitted = matched by words at paint time). */
export function speak(text: string, answerId: string | null = null, part: string | null = null, domBase?: number): void {
	const spans = sentenceSpans(text);
	if (!spans.length) return;
	audio();
	ending = false;
	for (const { start, end } of spans) {
		const t = text.slice(start, end).replace(/\s+/g, " ");
		const anchor = part ? { part, domStart: domBase === undefined ? undefined : domBase + start } : null;
		queue.push({ text: t, answerId, anchor, sent: false, flushed: false, start: null, end: 0 });
	}
	pump();
}

/** No more text for now: close the socket once everything is generated. */
export function endTurn(): void {
	ending = true;
	pump();
}

/** Cut everything now: queued text, in-flight generation, scheduled audio. */
export function stopVoice(): void {
	if (sock) {
		sock.dropped = true;
		sock.ws?.close();
		sock = null;
	}
	queue = [];
	ending = false;
	for (const src of sources) {
		try {
			src.stop();
		} catch {
			/* already stopped */
		}
	}
	sources.clear();
	nextTime = 0;
	if (paused) {
		paused = false;
		void ctx?.resume().catch(() => {});
	}
	cursor = null;
	clearHighlight();
	emit();
}

/** P / the ⏸ button: freeze or resume playback (idle = no-op). Text that
 *  arrives while paused queues; the highlight stays on the paused word.
 *  A MOVED or click-placed cursor (voice wave 4) wins: P reads from it. */
export function togglePause(): void {
	if (cursor && (cursor.moved || !isVoiceSpeaking())) return readFromCursor();
	if (paused) {
		paused = false;
		void ctx?.resume().catch(() => {});
	} else if (isVoiceSpeaking() && ctx) {
		paused = true;
		void ctx.suspend().catch(() => {});
	}
	emit();
}

/** Synchronous answer for the Esc chain (components/keyboard-shortcuts.tsx). */
export function isVoiceSpeaking(): boolean {
	prune();
	return queue.length > 0 || sources.size > 0;
}

/** Restart what is left at the CURRENT prefs (the speed change, owner
 *  2026-10-28): stop, then resume from the word being heard — estimated
 *  from the chunk's audio share played (no word timings exist). */
function respeak(): void {
	prune();
	if (!queue.length) return;
	const now = ctx?.currentTime ?? 0;
	const rest = queue.map((c) => ({ ...c, sent: false, flushed: false, start: null, end: 0 }));
	const first = queue[0]!;
	if (first.start !== null && now > first.start) {
		const cut = resumeOffset(first.text, (now - first.start) / chunkSpan(first));
		const head = rest[0]!;
		head.text = first.text.slice(cut);
		// The same screen words, minus the ones already heard.
		if (head.anchor) {
			const b = resolveBase(first);
			const skipped = wordTokens(first.text.slice(0, cut)).length;
			head.anchor = b === null ? { part: head.anchor.part } : { part: head.anchor.part, base: b < 0 ? -1 : b + skipped };
		}
	}
	const wasEnding = ending;
	const wasPaused = paused;
	stopVoice();
	audio();
	queue = rest.filter((c) => c.text.trim());
	if (wasPaused && ctx) {
		paused = true; // a speed change while paused stays paused
		void ctx.suspend().catch(() => {});
	}
	ending = wasEnding;
	pump();
}

/** Change the speed — mid-speech it resumes at the heard word. */
export function setVoiceSpeed(speed: number): void {
	saveVoicePrefs({ speed });
	if (isVoiceSpeaking()) respeak();
}

/** A chunk's audio length — still generating: the audio so far is a
 *  floor, ~14 chars/s the guess. */
function chunkSpan(c: Chunk): number {
	if (c.start === null) return 1;
	return c.flushed ? Math.max(0.001, c.end - c.start) : Math.max(c.end - c.start, c.text.length / 14);
}

// ─── the word highlight + follow-scroll ────────────────────────────────────

const HIGHLIGHT = "lh-voice-word";
/** Per passage: the next screen word auto-read matching searches from. */
const matchCursor = new Map<string, number>();
/** The learner scrolled: stop following until the next play/answer. */
let followPaused = false;
let lastWord: Range | null = null;
/** The last word painted from the audio — where an arrow press picks up. */
let lastSpot: { part: string; index: number } | null = null;

export function resumeFollow(): void {
	followPaused = false;
}
export function pauseFollow(): void {
	followPaused = true;
}

function passageEl(part: string): Element | null {
	return document.querySelector(`[data-voice-part="${CSS.escape(part)}"]`);
}

/** The first screen-word index of a chunk (cached in its anchor). */
function resolveBase(c: Chunk): number | null {
	const a = c.anchor;
	if (!a) return null;
	if (a.base !== undefined) return a.base;
	const el = passageEl(a.part);
	if (!el) return null; // not rendered yet — try again next paint
	const screen = wordTokens(passageSpeech(el).text);
	if (a.domStart !== undefined) {
		const i = screen.findIndex((t) => t.end > a.domStart!);
		a.base = i;
	} else {
		const i = matchWords(screen.map((t) => t.word), wordTokens(c.text).map((t) => t.word), matchCursor.get(a.part) ?? 0);
		a.base = i;
		if (i >= 0) matchCursor.set(a.part, i + wordTokens(c.text).length);
	}
	return a.base;
}

function clearHighlight(): void {
	lastWord = null;
	if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(HIGHLIGHT);
}

/** Paint the word being heard (faint green, ::highlight in globals.css) and
 *  keep it in view unless the learner scrolled away. */
function paint(): void {
	if (typeof CSS === "undefined" || !("highlights" in CSS) || !ctx) return;
	if (cursor) return; // the cursor owns the highlight (paintCursor)
	const now = ctx.currentTime;
	const c = queue.find((q) => q.start !== null && q.start <= now && now < q.end);
	if (!c?.anchor) return clearHighlight();
	const base = resolveBase(c);
	const word = wordAtFraction(c.text, (now - c.start!) / chunkSpan(c));
	if (base === null || base < 0 || word < 0) return clearHighlight();
	const el = passageEl(c.anchor.part);
	if (!el) return clearHighlight();
	const speech = passageSpeech(el);
	const tok = wordTokens(speech.text)[base + word];
	const range = tok ? rangeOf(speech, tok.start, tok.end) : null;
	if (!range) return clearHighlight();
	lastSpot = { part: c.anchor.part, index: base + word };
	CSS.highlights.set(HIGHLIGHT, new Highlight(range));
	const moved = !lastWord || lastWord.compareBoundaryPoints(Range.START_TO_START, range) !== 0;
	lastWord = range;
	if (moved && !followPaused) follow(range);
}

function follow(range: Range): void {
	const rect = range.getBoundingClientRect();
	let scroller: HTMLElement | null = range.startContainer.parentElement;
	while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
	if (!scroller) return;
	const box = scroller.getBoundingClientRect();
	if (rect.top >= box.top + 40 && rect.bottom <= box.bottom - 120) return; // in view (dock margin)
	scroller.scrollBy({ top: rect.top - (box.top + box.height / 2), behavior: "smooth" });
}

// ─── the reading cursor (voice wave 4, owner 2026-10-28) ────────────────────
//
// The highlight becomes a movable cursor: an arrow key or a clean left click
// on a word PAUSES reading and takes over the highlight; P reads from the
// cursor (an unmoved pause just resumes mid-word). ←/→ walk words across
// passages and answers; ↑/↓ go to the next VISUAL line (measured), keeping
// a sticky column across a run of presses like a text editor.

type Cursor = { part: string; index: number; moved: boolean };
let cursor: Cursor | null = null;
/** ↑/↓'s sticky column — reset by any other move. */
let goalX: number | null = null;

/** Fires the mounted tracker's playFrom (it owns skip/mute bookkeeping). */
export const VOICE_PLAY_FROM_EVENT = "lh:voice-play-from";

type ScreenWord = {
	part: string;
	answer: string | null;
	local: number;
	el: Element;
	speech: ReturnType<typeof passageSpeech>;
	start: number;
	end: number;
	word: string;
};

/** Every word of every teacher passage, in page order. */
function screenWords(): ScreenWord[] {
	const out: ScreenWord[] = [];
	for (const el of Array.from(document.querySelectorAll(`[${ANSWER_ATTR}] .${PASSAGE_CLASS}`))) {
		const part = el.getAttribute(PART_ATTR);
		if (!part) continue;
		const speech = passageSpeech(el);
		const answer = el.closest(`[${ANSWER_ATTR}]`)?.getAttribute(ANSWER_ATTR) ?? null;
		wordTokens(speech.text).forEach((t, local) =>
			out.push({ part, answer, local, el, speech, start: t.start, end: t.end, word: t.word }),
		);
	}
	return out;
}

function wordBox(w: ScreenWord): WordBox | null {
	const r = rangeOf(w.speech, w.start, w.end)?.getBoundingClientRect();
	return r && (r.width || r.height) ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
}

const PARAGRAPH = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre, .katex-display";

/** The paragraph-level block a word sits in (its passage when none). */
function blockOf(w: ScreenWord): Element {
	const spot = wordSpot(w.speech, w.start, w.end);
	const node = spot?.node;
	const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
	const block = el?.closest(PARAGRAPH);
	return block && w.el.contains(block) ? block : w.el;
}

function paintCursor(): void {
	if (!cursor || typeof CSS === "undefined" || !("highlights" in CSS)) return;
	const el = passageEl(cursor.part);
	if (!el) return clearVoiceCursor();
	const speech = passageSpeech(el);
	const tok = wordTokens(speech.text)[cursor.index];
	const range = tok ? rangeOf(speech, tok.start, tok.end) : null;
	if (!range) return clearVoiceCursor();
	CSS.highlights.set(HIGHLIGHT, new Highlight(range));
	lastWord = range;
	follow(range); // cursor moves always stay in view
}

/** Take over the highlight: pause anything playing, then park the cursor. */
function placeCursor(part: string, index: number): void {
	if (isVoiceSpeaking() && !paused && ctx) {
		paused = true;
		void ctx.suspend().catch(() => {});
	}
	cursor = { part, index, moved: true };
	paintCursor();
	emit();
}

/** Is the viewport point over the green word? (hover badge + click) */
export function pointOnHighlight(x: number, y: number): DOMRect | null {
	if (!lastWord || !lastWord.startContainer.isConnected) return null;
	for (const r of Array.from(lastWord.getClientRects())) {
		if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return lastWord.getBoundingClientRect();
	}
	return null;
}

export function hasVoiceCursor(): boolean {
	return cursor !== null;
}

export function clearVoiceCursor(): void {
	cursor = null;
	goalX = null;
	clearHighlight();
	emit();
}

function readFromCursor(): void {
	const c = cursor;
	if (!c) return;
	const el = passageEl(c.part);
	const tok = el ? wordTokens(passageSpeech(el).text)[c.index] : undefined;
	if (!el || !tok) return clearVoiceCursor();
	window.dispatchEvent(new CustomEvent(VOICE_PLAY_FROM_EVENT, { detail: { el, offset: tok.start } }));
}

/** Left click on a word (already judged a clean click): park there. */
export function placeCursorAt(passage: Element, speechOffset: number): void {
	const part = passage.getAttribute(PART_ATTR);
	if (!part) return;
	const tokens = wordTokens(passageSpeech(passage).text);
	let index = tokens.findIndex((t) => speechOffset < t.end);
	if (index < 0) index = tokens.length - 1;
	if (index < 0) return;
	goalX = null;
	placeCursor(part, index);
}

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * The window keydown for the cursor keys: plain ←/→ word, ↑/↓ next visual
 * line (sticky column); ⌥←/→ sentence, ⌥↑/↓ paragraph; ⌘(Ctrl)←/→ line
 * start/end, ⌘↑/↓ first/last word of the answer — again: the previous/
 * next answer (owner, 2026-10-28: macOS-style, one step up). Acts only
 * while a cursor exists or something reads (else the arrows keep their
 * browser meaning — scrolling, ⌘← history); never in a typing surface,
 * with Shift or ⌥⌘ together, or when a surface claimed it (the dock).
 */
export function onCursorKey(e: KeyboardEvent): void {
	if (!ARROWS.has(e.key) || e.defaultPrevented || e.shiftKey) return;
	const alt = e.altKey;
	const mod = e.metaKey || e.ctrlKey;
	if (alt && mod) return;
	if (isTypingSurface(e)) return;
	const from = cursor ?? (isVoiceSpeaking() && lastSpot ? { ...lastSpot, moved: false } : null);
	if (!from) return;
	e.preventDefault();
	const words = screenWords();
	const at = words.findIndex((w) => w.part === from.part && w.local === from.index);
	if (at < 0) return;
	const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
	const dir: 1 | -1 = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
	const cache = new Map<number, WordBox | null>();
	const box = (i: number) => {
		if (!cache.has(i)) cache.set(i, wordBox(words[i]!));
		return cache.get(i)!;
	};
	let to = at;
	if (!horizontal && !alt && !mod) {
		const here = box(at);
		if (!here) return;
		goalX ??= (here.left + here.right) / 2; // sticky only across ↑/↓ runs
		to = nextLineIndex(words.length, box, at, dir, goalX);
	} else {
		goalX = null;
		if (!alt && !mod) to = Math.max(0, Math.min(words.length - 1, at + dir));
		else if (alt && horizontal) to = jumpToStart(words.map((w, i) => startsSentence(i > 0 ? words[i - 1]!.word : undefined) || w.el !== words[i - 1]?.el), at, dir);
		else if (alt) to = jumpToStart(words.map((w, i) => i === 0 || blockOf(w) !== blockOf(words[i - 1]!)), at, dir);
		else if (horizontal) to = lineEdgeIndex(words.length, box, at, dir);
		else {
			// ⌘↑/↓: this answer's first/last word; already there → the previous/next answer's.
			const edge = (answer: string | null) => {
				const idx = words.flatMap((w, i) => (w.answer === answer ? [i] : []));
				return dir < 0 ? idx[0]! : idx[idx.length - 1]!;
			};
			to = edge(words[at]!.answer);
			if (to === at) {
				let i = at + dir;
				while (i >= 0 && i < words.length && words[i]!.answer === words[at]!.answer) i += dir;
				if (i >= 0 && i < words.length) to = edge(words[i]!.answer);
			}
		}
	}
	const w = words[to]!;
	placeCursor(w.part, w.local);
}

// The UI's view of the engine: speaking at all, paused, the answer audible.
export type VoiceState = { speaking: boolean; paused: boolean; answerId: string | null; cursor: boolean };
let state: VoiceState = { speaking: false, paused: false, answerId: null, cursor: false };
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit(): void {
	const now = ctx?.currentTime ?? 0;
	const speaking = queue.length > 0 || sources.size > 0;
	const audible = queue.find((c) => c.start !== null && c.start <= now && now < c.end) ?? queue[0];
	const answerId = speaking ? (audible?.answerId ?? null) : null;
	if (speaking && !ticker) ticker = setInterval(() => (prune(), emit(), paint()), 100);
	if (!speaking && ticker) {
		clearInterval(ticker);
		ticker = null;
		if (!cursor) clearHighlight();
	}
	const hasCursor = cursor !== null;
	if (speaking === state.speaking && paused === state.paused && answerId === state.answerId && hasCursor === state.cursor) return;
	state = { speaking, paused, answerId, cursor: hasCursor };
	for (const l of listeners) l();
}

/** Subscribe a component to the engine state. */
export function useVoiceState(): VoiceState {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => state,
		() => IDLE,
	);
}
const IDLE: VoiceState = { speaking: false, paused: false, answerId: null, cursor: false };

/** The Esc chain's stop: the mounted read-aloud tracker mutes the rest of
 *  the current turn on this event (the engine stop runs here). */
export const VOICE_ESC_EVENT = "lh:voice-esc";

// ─── prefs + the toggle ────────────────────────────────────────────────────

export type Voice = {
	enabled: boolean;
	voice: string;
	speed: number;
	error: string | null;
	toggle: () => void;
	clearError: () => void;
};

/** One instance on the chat page: prefs mirror, ⌥S, the error line. */
export function useVoice(): Voice {
	// Defaults on the server render; the device prefs load after mount.
	const [prefs, setPrefs] = useState<VoicePrefs>({ enabled: false, voice: DEFAULT_VOICE, speed: DEFAULT_SPEED });
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const sync = () => setPrefs(loadVoicePrefs());
		sync();
		window.addEventListener(VOICE_PREFS_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(VOICE_PREFS_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);
	useEffect(() => {
		reportError = setError;
		return () => {
			if (reportError === setError) reportError = null;
		};
	}, []);
	// Voice on after a reload: the first gesture resumes the context.
	useEffect(() => {
		if (!prefs.enabled) return;
		const unlock = () => unlockAudio();
		window.addEventListener("pointerdown", unlock, { capture: true, once: true });
		window.addEventListener("keydown", unlock, { capture: true, once: true });
		return () => {
			window.removeEventListener("pointerdown", unlock, { capture: true });
			window.removeEventListener("keydown", unlock, { capture: true });
		};
	}, [prefs.enabled]);

	const toggle = useCallback(() => {
		const next = !loadVoicePrefs().enabled;
		setError(null);
		if (next) {
			unlockAudio(); // under the click/⌥S gesture
			warmTokens.mint().catch((e: unknown) => {
				if (e instanceof DeepgramKeylessError) setError(VOICE_KEYLESS);
			});
		} else {
			stopVoice();
		}
		setPrefs(saveVoicePrefs({ enabled: next }));
	}, []);
	useEffect(() => {
		const ev = kbdEventForAction("toggle-voice");
		window.addEventListener(ev, toggle);
		return () => window.removeEventListener(ev, toggle);
	}, [toggle]);
	// ←→↑↓ move the reading cursor (no-op — the arrows scroll — when there
	// is no cursor and nothing reads; the dock's row machine claims first).
	useEffect(() => {
		window.addEventListener("keydown", onCursorKey);
		return () => window.removeEventListener("keydown", onCursorKey);
	}, []);
	// P (the registry's bare key — never fires in a text field).
	useEffect(() => {
		const ev = kbdEventForAction("toggle-voice-pause");
		window.addEventListener(ev, togglePause);
		return () => window.removeEventListener(ev, togglePause);
	}, []);
	// The learner scrolling stops the highlight-follow until the next
	// play/answer (programmatic smooth scrolls fire none of these).
	useEffect(() => {
		const keys = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);
		// An arrow the cursor consumed (defaultPrevented) is not a scroll.
		const onKey = (e: KeyboardEvent) => {
			if (keys.has(e.key) && !e.defaultPrevented) pauseFollow();
		};
		window.addEventListener("wheel", pauseFollow, { passive: true });
		window.addEventListener("touchmove", pauseFollow, { passive: true });
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("wheel", pauseFollow);
			window.removeEventListener("touchmove", pauseFollow);
			window.removeEventListener("keydown", onKey);
		};
	}, []);

	return { ...prefs, error, toggle, clearError: () => setError(null) };
}

// ─── the chat tracker ──────────────────────────────────────────────────────

type Pending = { toolCallId: string; tool: string; input: unknown } | null;

/**
 * Feed the live teacher prose (and the pending question) to the engine.
 * Every assistant text part carries a spoken offset; a part first seen
 * while no turn runs is baselined at its full length (history, syncs,
 * reloads never read), and while voice is off or the turn is muted the
 * offsets simply track the text. `interrupt(mute)` cuts the speech —
 * muted = silent until the next turn starts (Esc, dictation); unmuted =
 * only what already arrived is skipped (send/answer: the reply reads).
 *
 * Manual reading (voice wave 2, owner 2026-10-28) — ▶ on an answer and
 * right-click on a sentence: reads the RENDERED prose (components/
 * voice-dom.ts) from that point through every later answer to the newest,
 * then the waiting question if it speaks; works with auto-read off. It
 * skips everything already arrived for auto-read, so live text that keeps
 * streaming queues AFTER it (auto-read on) instead of doubling.
 */
export function useReadAloud({
	messages,
	busy,
	pending,
	voice,
}: {
	messages: LhViewMessage[];
	busy: boolean;
	pending: Pending;
	voice: Voice;
}): ReadAloud {
	const offsets = useRef(new Map<string, number>());
	const muted = useRef(false);
	const spokenQuestion = useRef<string | null | undefined>(undefined);
	const wasBusy = useRef(busy);
	const wasEnabled = useRef(voice.enabled);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const pendingRef = useRef(pending);
	pendingRef.current = pending;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	const skipArrived = useCallback(() => {
		for (const [key, text] of textParts(messagesRef.current)) offsets.current.set(key, text.length);
		spokenQuestion.current = pendingRef.current?.toolCallId ?? null;
	}, []);

	const interrupt = useCallback(
		(mute: boolean) => {
			stopVoice();
			skipArrived();
			if (mute) muted.current = true;
		},
		[skipArrived],
	);

	const playFrom = useCallback(
		(passage: Element, offset = 0) => {
			const passages = Array.from(document.querySelectorAll(`[${ANSWER_ATTR}] .${PASSAGE_CLASS}`));
			const from = passages.indexOf(passage);
			if (from < 0) return;
			unlockAudio(); // under the click gesture
			stopVoice();
			skipArrived();
			muted.current = false;
			resumeFollow();
			for (let i = from; i < passages.length; i++) {
				const p = passages[i]!;
				const text = passageSpeech(p).text;
				const start = i === from ? offset : 0;
				speak(
					text.slice(start),
					p.closest(`[${ANSWER_ATTR}]`)?.getAttribute(ANSWER_ATTR) ?? null,
					p.getAttribute(PART_ATTR),
					start,
				);
			}
			const q = pendingRef.current;
			const line = q ? questionSpeech(q.tool, q.input) : null;
			if (line) speak(line);
			if (!busyRef.current) endTurn();
		},
		[skipArrived],
	);

	const playAnswer = useCallback(
		(answerId: string) => {
			const first = document.querySelector(`[${ANSWER_ATTR}="${CSS.escape(answerId)}"] .${PASSAGE_CLASS}`);
			if (first) playFrom(first);
		},
		[playFrom],
	);

	/** Right-click a word: read from it (owner, 2026-10-28 — was the
	 *  sentence) — unless text is selected
	 *  (then the browser menu stays, for copying). */
	const onContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (!window.getSelection()?.isCollapsed) return;
			const passage = (e.target as Element).closest?.(`[${ANSWER_ATTR}] .${PASSAGE_CLASS}`);
			if (!passage) return;
			const caret = caretAt(e.clientX, e.clientY);
			if (!caret || !passage.contains(caret.node)) return;
			const speech = passageSpeech(passage);
			const at = speechOffsetOf(speech, caret.node, caret.offset);
			if (at === null) return;
			e.preventDefault();
			playFrom(passage, wordStartBefore(speech.text, at));
		},
		[playFrom],
	);

	// P on a moved/placed cursor (the engine fires; playFrom owns the
	// skip/mute bookkeeping).
	useEffect(() => {
		const onPlayFrom = (e: Event) => {
			const { el, offset } = (e as CustomEvent<{ el: Element; offset: number }>).detail;
			playFrom(el, offset);
		};
		window.addEventListener(VOICE_PLAY_FROM_EVENT, onPlayFrom);
		return () => window.removeEventListener(VOICE_PLAY_FROM_EVENT, onPlayFrom);
	}, [playFrom]);

	/* Left click (voice wave 4): a CLEAN single click on teacher prose —
	 * never a selection gesture (isCursorClick) and never the first half of
	 * a double-click (a ~250ms wait) — reads from the word when it is the
	 * green word (owner: hover shows the speaker badge), else parks the
	 * reading cursor there (pausing any reading). */
	const down = useRef<{ x: number; y: number } | null>(null);
	const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onMouseDown = useCallback((e: React.MouseEvent) => {
		down.current = { x: e.clientX, y: e.clientY };
		if (e.detail > 1 && clickTimer.current) {
			clearTimeout(clickTimer.current); // a double/triple click: selection wins
			clickTimer.current = null;
		}
	}, []);
	const onMouseUp = useCallback(
		(e: React.MouseEvent) => {
			const start = down.current;
			down.current = null;
			const target = e.target as Element;
			const passage = target.closest?.(`[${ANSWER_ATTR}] .${PASSAGE_CLASS}`);
			if (!start || !passage) return;
			const x = e.clientX, y = e.clientY;
			const clean = isCursorClick({
				button: e.button,
				detail: e.detail,
				modifier: e.shiftKey || e.metaKey || e.ctrlKey || e.altKey,
				travel: Math.hypot(x - start.x, y - start.y),
				selectionCollapsed: window.getSelection()?.isCollapsed ?? true,
				interactive: !!target.closest("a, button, [role=button], input, textarea, select, summary, svg, img, figure, [data-lh-figure]"),
			});
			if (!clean) return;
			if (clickTimer.current) clearTimeout(clickTimer.current);
			clickTimer.current = setTimeout(() => {
				clickTimer.current = null;
				if (!(window.getSelection()?.isCollapsed ?? true)) return; // a selection landed meanwhile
				const caret = caretAt(x, y);
				if (!caret || !passage.contains(caret.node)) return;
				const speech = passageSpeech(passage);
				const at = speechOffsetOf(speech, caret.node, caret.offset);
				if (at === null) return;
				if (pointOnHighlight(x, y)) playFrom(passage, wordStartBefore(speech.text, at));
				else placeCursorAt(passage, at);
			}, 250);
		},
		[playFrom],
	);
	useEffect(() => () => {
		if (clickTimer.current) clearTimeout(clickTimer.current);
	}, []);

	useEffect(() => {
		const onEsc = () => interrupt(true);
		window.addEventListener(VOICE_ESC_EVENT, onEsc);
		return () => window.removeEventListener(VOICE_ESC_EVENT, onEsc);
	}, [interrupt]);

	useEffect(() => {
		if (busy && !wasBusy.current) {
			muted.current = false; // a new turn reads fresh
			resumeFollow(); // …and the highlight is followed again
		}
		if (voice.enabled && !wasEnabled.current) muted.current = false;
		wasBusy.current = busy;
		wasEnabled.current = voice.enabled;
		const silent = !voice.enabled || muted.current;

		for (const [key, text, complete, answerId] of textParts(messages)) {
			const seen = offsets.current.get(key);
			if (seen === undefined && (!busy || spokenQuestion.current === undefined)) {
				offsets.current.set(key, text.length); // history / mount: never read
				continue;
			}
			const from = seen ?? 0;
			if (silent) {
				offsets.current.set(key, text.length);
				continue;
			}
			const take = takeSpeakable(text, from, complete || !busy);
			if (take.text) speak(take.text, answerId, key);
			offsets.current.set(key, take.next);
		}

		const qid = pending?.toolCallId ?? null;
		if (spokenQuestion.current === undefined) spokenQuestion.current = qid; // mount
		else if (qid && qid !== spokenQuestion.current) {
			spokenQuestion.current = qid;
			const line = silent ? null : questionSpeech(pending!.tool, pending!.input);
			if (line) speak(line);
		}
		if (!busy) endTurn();
	}, [messages, busy, pending, voice.enabled]);

	return { interrupt, playAnswer, onContextMenu, onMouseDown, onMouseUp, stop: () => interrupt(true) };
}

export type ReadAloud = {
	interrupt: (mute: boolean) => void;
	/** ▶ on an answer: read it and everything after. */
	playAnswer: (answerId: string) => void;
	/** The transcript's right-click: read from the clicked word. */
	onContextMenu: (e: React.MouseEvent) => void;
	/** The transcript's clean left click: the green word reads from it,
	 *  any other word parks the reading cursor. */
	onMouseDown: (e: React.MouseEvent) => void;
	onMouseUp: (e: React.MouseEvent) => void;
	/** ■: stop and silence the rest of the turn (Esc's semantics). */
	stop: () => void;
};

/** The transcript markers manual reading walks: each assistant answer's
 *  wrapper carries ANSWER_ATTR=<view message id>; prose blocks are the
 *  existing `.lh-source-passage` divs. */
export const ANSWER_ATTR = "data-voice-answer";
/** Each prose passage's part id (`<native id>-t<n>`) — the highlight's
 *  anchor, shared by auto-read (its text-part key) and manual reading. */
export const PART_ATTR = "data-voice-part";
const PASSAGE_CLASS = "lh-source-passage";

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
	const d = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const pos = d.caretPositionFromPoint?.(x, y);
	if (pos) return { node: pos.offsetNode, offset: pos.offset };
	const range = d.caretRangeFromPoint?.(x, y);
	return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Every assistant text part: [stable key, text, complete] — the key is
 *  the view's `<native id>-t<n>` part id (stable across stream → sync);
 *  complete when a later part follows it (the stream moved on). */
function* textParts(messages: LhViewMessage[]): Generator<[string, string, boolean, string]> {
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (let i = 0; i < m.parts.length; i++) {
			const p = m.parts[i]!;
			if (p.type !== "text" || typeof p.text !== "string") continue;
			yield [typeof p.id === "string" ? p.id : `${m.id}:${i}`, p.text, i < m.parts.length - 1, m.id];
		}
	}
}

// ─── the button ────────────────────────────────────────────────────────────

/** The stats-row toggle beside the mic. Keyless → deep-links Settings →
 *  Keys → the Deepgram row (dictation's pattern). */
export function VoiceButton({ voice }: { voice: Voice }) {
	const { enabled, error, toggle, clearError } = voice;
	const { open: openSettings } = useSettingsDialog();
	return (
		<Hint label={error ?? "Read aloud"} action={error ? undefined : "toggle-voice"} side="top">
			<button
				type="button"
				onClick={() => {
					if (error === VOICE_KEYLESS) {
						clearError();
						openSettings("keys", DEEPGRAM_KEY_ID);
					} else toggle();
				}}
				aria-pressed={enabled}
				aria-label={error ? `Read aloud failed: ${error}` : enabled ? "Turn off read aloud" : "Turn on read aloud"}
				data-testid="voice-toggle"
				className={cn(
					"flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-card/50 shadow-lg backdrop-blur transition-colors",
					error
						? "border-destructive/50 text-destructive"
						: enabled
							? "border-border text-foreground"
							: "border-border/50 text-muted-foreground/70 hover:border-border hover:text-muted-foreground",
				)}
			>
				{enabled && !error ? <Volume2Icon className="size-3.5" /> : <VolumeXIcon className="size-3.5" />}
			</button>
		</Hint>
	);
}

/** The quick speed control beside the speaker: "1.0×", click opens the
 *  0.7–1.5× menu (owner, 2026-10-28). A pick mid-speech resumes at the
 *  heard word (setVoiceSpeed). */
export function SpeedPill({ voice }: { voice: Voice }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		// The model picker's dropdown contract: outside click or Esc closes;
		// the portaled body is carved out via [data-lh-menu].
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (ref.current && !ref.current.contains(t)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	return (
		<div ref={ref} className="shrink-0">
			<Hint label="Read-aloud speed" side="top">
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					aria-label={`Read-aloud speed ${formatSpeed(voice.speed)}`}
					data-testid="voice-speed"
					className="flex h-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-card/50 px-1.5 font-mono text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
				>
					{formatSpeed(voice.speed)}
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={ref}
					testid="voice-speed-menu"
					preferredSide="up"
					menuClass="flex w-28 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{VOICE_SPEEDS.map((sp) => (
						<button
							key={sp}
							type="button"
							data-testid={`voice-speed-${sp}`}
							onClick={() => {
								setVoiceSpeed(sp);
								setOpen(false);
							}}
							className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left font-mono transition-colors hover:bg-muted ${
								sp === voice.speed ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
							}`}
						>
							<span>{formatSpeed(sp)}</span>
							{sp === voice.speed && <span aria-hidden>✓</span>}
						</button>
					))}
				</MenuShell>
			)}
		</div>
	);
}

/** The stats-row ■ — only while anything speaks (Esc's semantics). */
export function VoiceStopButton({ onStop }: { onStop: () => void }) {
	const { speaking } = useVoiceState();
	if (!speaking) return null;
	return (
		<Hint label="Stop reading (Esc)" side="top">
			<button
				type="button"
				onClick={onStop}
				aria-label="Stop reading"
				data-testid="voice-stop"
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card/50 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent"
			>
				<SquareIcon className="size-3" />
			</button>
		</Hint>
	);
}

/** The per-answer ▶/■ in the answer's top-left margin: ▶ on hover reads
 *  this answer and everything after; ■ (visible while THIS answer is the
 *  one audible) stops. The answer wrapper must be `group relative`. */
export function AnswerPlayButton({ answerId, readAloud }: { answerId: string; readAloud: ReadAloud }) {
	const { answerId: playing } = useVoiceState();
	const active = playing === answerId;
	return (
		<button
			type="button"
			onClick={() => (active ? readAloud.stop() : readAloud.playAnswer(answerId))}
			aria-label={active ? "Stop reading" : "Read aloud from here"}
			title={active ? "Stop reading" : "Read aloud from here"}
			data-testid="answer-play"
			className={cn(
				"absolute -left-6 top-0.5 flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground",
				active ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
			)}
		>
			{active ? <SquareIcon className="size-3" /> : <PlayIcon className="size-3" />}
		</button>
	);
}

/** The stats-row ⏸/▶ beside ■ — mirrors P (shown while anything reads). */
export function VoicePauseButton() {
	const { speaking, paused, cursor } = useVoiceState();
	if (!speaking && !cursor) return null;
	const resume = paused || !speaking;
	return (
		<Hint label={!speaking ? "Read from the highlighted word" : paused ? "Resume reading" : "Pause reading"} action="toggle-voice-pause" side="top">
			<button
				type="button"
				onClick={togglePause}
				aria-label={resume ? "Resume reading" : "Pause reading"}
				aria-pressed={resume}
				data-testid="voice-pause"
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card/50 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent"
			>
				{resume ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
			</button>
		</Hint>
	);
}

/** Hovering the green word (owner, 2026-10-28): a small speaker badge
 *  floats above it and the pointer becomes a hand — a click reads from
 *  there. Window-level so it tracks a highlight that moves under a still
 *  mouse; re-checked on pointer moves and a short tick while shown. */
export function HighlightHoverBadge() {
	const [at, setAt] = useState<DOMRect | null>(null);
	useEffect(() => {
		let x = -1, y = -1, frame = 0;
		const check = () => {
			frame = 0;
			const r = pointOnHighlight(x, y);
			document.documentElement.style.cursor = r ? "pointer" : "";
			setAt((prev) => (r && prev && r.top === prev.top && r.left === prev.left ? prev : r));
		};
		const onMove = (e: PointerEvent) => {
			x = e.clientX;
			y = e.clientY;
			if (!frame) frame = requestAnimationFrame(check);
		};
		const tick = setInterval(check, 150);
		window.addEventListener("pointermove", onMove, { passive: true });
		return () => {
			window.removeEventListener("pointermove", onMove);
			clearInterval(tick);
			if (frame) cancelAnimationFrame(frame);
			document.documentElement.style.cursor = "";
		};
	}, []);
	if (!at) return null;
	return (
		<div
			aria-hidden
			data-testid="voice-hover-badge"
			className="pointer-events-none fixed z-50 flex size-5 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md"
			style={{ left: at.left + at.width / 2 - 10, top: at.top - 24 }}
		>
			<Volume2Icon className="size-3" />
		</div>
	);
}
