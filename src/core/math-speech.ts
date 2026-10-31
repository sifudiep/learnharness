/**
 * Math → speech for read-aloud (owner, 2026-10-31): equations are spoken,
 * not replaced by "(equation)". ONE converter serves both reading paths —
 * auto-read (markdown source, speakableText) and manual reading (rendered
 * KaTeX, passageSpeech) — so the same TeX always yields the same words and
 * the on-screen word matching keeps working.
 *
 * Engine: speech-rule-engine (the engine MathJax uses for screen readers),
 * ClearSpeak style, fed KaTeX's MathML. It loads lazily (loadMathSpeech);
 * until it is ready, or when a formula cannot be read, mathToSpeech returns
 * EQUATION_WORD — the old behaviour, never silence or raw TeX.
 *
 * The locale files ship inside the app bundle via the engine's custom
 * loader — never fetched from a CDN (browser-verified: without it the
 * engine pulls them from jsDelivr).
 */

import katex from "katex";

export const EQUATION_WORD = "(equation)";

type Sre = {
	setupEngine(feature: Record<string, unknown>): Promise<unknown>;
	engineReady(): Promise<unknown>;
	toSpeech(expr: string): string;
};

let engine: Sre | null = null;
let loading: Promise<void> | null = null;

/** The bundled locale files the engine asks for (it requests "base" and
 *  the locale itself). */
async function bundledLocale(locale: string): Promise<string> {
	const mod =
		locale === "base" ? await import("speech-rule-engine/lib/mathmaps/base.json")
		: locale === "en" ? await import("speech-rule-engine/lib/mathmaps/en.json")
		: null;
	if (!mod) throw new Error(`math speech: no bundled locale "${locale}"`);
	return JSON.stringify((mod as { default?: unknown }).default ?? mod);
}

const FEATURES = {
	locale: "en",
	domain: "clearspeak",
	modality: "speech",
	// The engine's option is `custom` (its .d.ts calls the field customLoader).
	custom: bundledLocale,
};

/** Load and configure the engine once. Safe to call repeatedly; a failed
 *  load is retried on the next call. */
export function loadMathSpeech(): Promise<void> {
	if (engine) return Promise.resolve();
	loading ??= (async () => {
		// Importing the engine in a browser immediately runs its own setup,
		// which would fetch the locale files from jsDelivr. The engine merges
		// the global SREfeature into EVERY setup — that first one included —
		// so the bundled loader must be in place before the import.
		(globalThis as { SREfeature?: unknown }).SREfeature = FEATURES;
		const mod = (await import("speech-rule-engine")) as unknown as Sre & { default?: Sre };
		const sre = typeof mod.setupEngine === "function" ? mod : mod.default!;
		await sre.setupEngine(FEATURES);
		await sre.engineReady();
		engine = sre;
	})().catch((e: unknown) => {
		loading = null;
		throw e;
	});
	return loading;
}

export function mathSpeechReady(): boolean {
	return engine !== null;
}

// ─── fix-ups (owner, 2026-10-31) ────────────────────────────────────────────
// Rewritten at the TeX level, before the engine runs, where the meaning is
// still unambiguous — never by editing the spoken words afterwards.

const said = (words: string) => `\\text{ ${words} }`;

/** Within the parentheses of P(…) / \Pr(…), a bar reads "given". */
function givenInProbability(tex: string): string {
	let out = "";
	let i = 0;
	const opener = /(?:\\Pr|(?<![A-Za-z\\])P)\s*(?:\\left\s*)?\(/g;
	for (let m = opener.exec(tex); m; m = opener.exec(tex)) {
		if (m.index < i) continue;
		const start = m.index + m[0].length;
		let depth = 1, j = start;
		for (; j < tex.length && depth > 0; j++) {
			if (tex[j] === "(") depth++;
			else if (tex[j] === ")") depth--;
		}
		if (depth > 0) break;
		const inner = tex.slice(start, j - 1)
			.replace(/\\(?:middle\s*)?(?:mid|vert)(?![A-Za-z])|\\middle\s*\||\|/g, said("given"));
		out += tex.slice(i, start) + inner;
		i = j - 1;
		opener.lastIndex = j;
	}
	return out + tex.slice(i);
}

export function mathFixups(tex: string): string {
	return givenInProbability(
		tex
			.replace(/\\(?:implies|Longrightarrow|Rightarrow)(?![A-Za-z])/g, said("implies"))
			// The engine reads the Δ glyph as "triangle".
			.replace(/\\Delta(?![A-Za-z])/g, said("Delta"))
			.replace(
				/\\lim\s*(?:\\limits\s*)?_\s*\{([^{}]*?)\\(?:to|rightarrow)(?![A-Za-z])([^{}]*)\}/g,
				(_, v: string, a: string) => `${said("the limit as")}${v.trim()}${said("approaches")}${a.trim()}${said("of")}`,
			),
	);
}

/** KaTeX marks upright symbols (∞, \mathrm, capital Greek) with
 *  mathvariant="normal", which the engine voices as the font: "normal
 *  infinity". Upright carries no meaning aloud. */
const UPRIGHT = / mathvariant="normal"/g;

/** Spoken words for one formula's TeX (no delimiters). Synchronous; falls
 *  back to EQUATION_WORD before the engine loads or on unreadable TeX. */
export function mathToSpeech(tex: string): string {
	const body = tex.trim();
	if (!engine || !body) return EQUATION_WORD;
	try {
		const mathml = katex.renderToString(mathFixups(body), { output: "mathml", throwOnError: true, strict: false, trust: false });
		const math = /<math[\s\S]*<\/math>/.exec(mathml)?.[0].replace(UPRIGHT, "");
		const words = math ? engine.toSpeech(math).replace(/\p{M}+/gu, "").replace(/\s+/g, " ").trim() : "";
		return words || EQUATION_WORD;
	} catch {
		return EQUATION_WORD;
	}
}
