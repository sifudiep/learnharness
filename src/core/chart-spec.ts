/**
 * The ```chart fence (stock-chart wave, owner 2026-11-01): price action
 * drawn as a real candlestick chart instead of ASCII. The teacher writes
 * DATA (bars, levels, marks, lines) — never pixels — and the renderer
 * (components/stock-chart.tsx, TradingView Lightweight Charts) draws it.
 * PURE, browser-safe: this module only parses and validates, so a wrong
 * candle surfaces as a precise error instead of a chart asserting a lie.
 *
 * ```chart
 * {
 *   "title": "Daily — two weeks before entry",
 *   "bars": [{"t": "Mon", "o": 205, "h": 206, "l": 201, "c": 203}],
 *   "levels": [{"price": 212, "label": "daily protected high", "style": "dashed"}],
 *   "marks": [{"t": "Mon", "at": "low", "text": "pullback low 201"}],
 *   "lines": [{"from": {"t": "Mon", "price": 201}, "to": {"t": "Fri", "price": 208.5}, "label": "trendline"}]
 * }
 * ```
 */

export type ChartTone = "neutral" | "up" | "down" | "accent";
export type ChartLineStyle = "solid" | "dashed" | "dotted";

export interface ChartBar {
	/** The bar's label on the time axis — a date ("2026-10-20") or any
	 *  name ("Mon", "W12"). Unique within the chart. */
	t: string;
	o: number;
	h: number;
	l: number;
	c: number;
}

export interface ChartLevel {
	price: number;
	label?: string;
	style: ChartLineStyle;
	tone: ChartTone;
}

export interface ChartMark {
	t: string;
	/** Which end of the bar the mark points at (default "high"). */
	at: "high" | "low";
	text?: string;
	tone: ChartTone;
}

export interface ChartLine {
	from: { t: string; price: number };
	to: { t: string; price: number };
	label?: string;
	style: ChartLineStyle;
	tone: ChartTone;
}

export interface ChartSpec {
	title?: string;
	bars: ChartBar[];
	levels: ChartLevel[];
	marks: ChartMark[];
	lines: ChartLine[];
}

export const MAX_CHART_BARS = 2000;

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; error: string };

const TONES: readonly ChartTone[] = ["neutral", "up", "down", "accent"];
const STYLES: readonly ChartLineStyle[] = ["solid", "dashed", "dotted"];

class SpecError extends Error {}

function num(v: unknown, where: string): number {
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	if (typeof v !== "number" || !Number.isFinite(v)) throw new SpecError(`${where} must be a number`);
	return v;
}

function label(v: unknown, where: string): string | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string" && typeof v !== "number") throw new SpecError(`${where} must be text`);
	return String(v);
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T, where: string): T {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "string" || !allowed.includes(v as T)) throw new SpecError(`${where} must be one of ${allowed.join(", ")}`);
	return v as T;
}

function list(v: unknown, where: string): unknown[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw new SpecError(`${where} must be a list`);
	return v;
}

/** Parse + validate a ```chart fence body. */
export function parseChartSpec(source: string): ChartParse {
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (e) {
		return { ok: false, error: `Chart data is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	try {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SpecError("Chart data must be an object with a \"bars\" list");
		const r = raw as Record<string, unknown>;
		const barsRaw = list(r.bars, "bars");
		if (!barsRaw.length) throw new SpecError("bars must list at least one bar");
		if (barsRaw.length > MAX_CHART_BARS) throw new SpecError(`bars is capped at ${MAX_CHART_BARS}`);
		const seen = new Set<string>();
		const bars = barsRaw.map((b, i): ChartBar => {
			const o = (b ?? {}) as Record<string, unknown>;
			const t = label(o.t, `bar ${i + 1} t`);
			if (t === undefined) throw new SpecError(`bar ${i + 1} needs a "t" label`);
			if (seen.has(t)) throw new SpecError(`bar label "${t}" is used twice — labels must be unique`);
			seen.add(t);
			const at = `bar "${t}"`;
			const bar = { t, o: num(o.o, `${at} o`), h: num(o.h, `${at} h`), l: num(o.l, `${at} l`), c: num(o.c, `${at} c`) };
			if (bar.h < Math.max(bar.o, bar.c)) throw new SpecError(`${at}: high ${bar.h} is below its open/close`);
			if (bar.l > Math.min(bar.o, bar.c)) throw new SpecError(`${at}: low ${bar.l} is above its open/close`);
			return bar;
		});
		const known = (t: unknown, where: string): string => {
			const s = label(t, where);
			if (s === undefined || !seen.has(s)) throw new SpecError(`${where} "${s ?? ""}" is not a bar label`);
			return s;
		};
		const levels = list(r.levels, "levels").map((v, i): ChartLevel => {
			const o = (v ?? {}) as Record<string, unknown>;
			const where = `level ${i + 1}`;
			return {
				price: num(o.price, `${where} price`),
				label: label(o.label, `${where} label`),
				style: pick(o.style, STYLES, "solid", `${where} style`),
				tone: pick(o.tone, TONES, "neutral", `${where} tone`),
			};
		});
		const marks = list(r.marks, "marks").map((v, i): ChartMark => {
			const o = (v ?? {}) as Record<string, unknown>;
			const where = `mark ${i + 1}`;
			return {
				t: known(o.t, `${where} t`),
				at: pick(o.at, ["high", "low"] as const, "high", `${where} at`),
				text: label(o.text, `${where} text`),
				tone: pick(o.tone, TONES, "accent", `${where} tone`),
			};
		});
		const index = new Map(bars.map((b, i) => [b.t, i]));
		const lines = list(r.lines, "lines").map((v, i): ChartLine => {
			const o = (v ?? {}) as Record<string, unknown>;
			const where = `line ${i + 1}`;
			const end = (p: unknown, which: string) => {
				const e = (p ?? {}) as Record<string, unknown>;
				return { t: known(e.t, `${where} ${which}.t`), price: num(e.price, `${where} ${which}.price`) };
			};
			let from = end(o.from, "from");
			let to = end(o.to, "to");
			if (from.t === to.t) throw new SpecError(`${where} must join two different bars`);
			if (index.get(from.t)! > index.get(to.t)!) [from, to] = [to, from];
			return {
				from,
				to,
				label: label(o.label, `${where} label`),
				style: pick(o.style, STYLES, "solid", `${where} style`),
				tone: pick(o.tone, TONES, "accent", `${where} tone`),
			};
		});
		return { ok: true, spec: { title: label(r.title, "title"), bars, levels, marks, lines } };
	} catch (e) {
		if (e instanceof SpecError) return { ok: false, error: `Chart data error — ${e.message}` };
		throw e;
	}
}
