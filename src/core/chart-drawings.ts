/**
 * Learner-drawn chart annotations (owner, 2026-11-04): fib retracement,
 * rectangle with text, named trend line, named horizontal line — drawn in
 * the full-screen chart, SAVED WITH THE CHAT (record.chartDrawings, keyed
 * by a hash of the chart's data), and shown to the TEACHER as a short text
 * summary attached to the learner's next turn — only what changed since
 * it was last shared. PURE, browser-safe.
 *
 * Anchors are DATA coordinates — `bar` is the bar's logical index (a
 * float; anchors may sit past the last bar) and `price` — so a drawing
 * stays put through zoom, pan and a different screen size.
 */

import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";

export interface DrawPoint {
	bar: number;
	price: number;
}

export interface FibLevel {
	value: number;
	color: string;
	on: boolean;
}

export interface FibStyle {
	levels: FibLevel[];
	trendLine: boolean;
	background: boolean;
	reverse: boolean;
	prices: boolean;
	levelLabels: boolean;
	labelSide: "left" | "right";
}

export const PALETTE = {
	yellow: "#facc15",
	green: "#22c55e",
	red: "#ef4444",
	blue: "#3b82f6",
	purple: "#a855f7",
	gray: "#9ca3af",
} as const;
export type PaletteColor = keyof typeof PALETTE;
export const PALETTE_COLORS = Object.keys(PALETTE) as PaletteColor[];

export type Drawing =
	| { id: string; kind: "fib"; a: DrawPoint; b: DrawPoint; style: FibStyle }
	| { id: string; kind: "rect"; a: DrawPoint; b: DrawPoint; color: PaletteColor; text?: string }
	| { id: string; kind: "trend"; a: DrawPoint; b: DrawPoint; color: PaletteColor; dashed?: boolean; name?: string }
	| { id: string; kind: "hline"; price: number; color: PaletteColor; dashed?: boolean; name?: string };

export type DrawingKind = Drawing["kind"];

/** One chart's saved drawings plus what the summary needs to name bars. */
export interface ChartDrawingsEntry {
	title?: string;
	/** The bar labels in order (the `t` of each bar). */
	labels: string[];
	drawings: Drawing[];
}

export type ChartDrawingsMap = Record<string, ChartDrawingsEntry>;

const WHITE = "#e6e6e6";

/** The owner's TradingView fib template (screenshot, 2026-11-04): the full
 *  level list in TradingView's order; ON = 0, 0.618, 0.786, 0.826, 1 (all
 *  white); dashed gray trend line; no background, not reversed, no price
 *  or level labels. */
export const DEFAULT_FIB_STYLE: FibStyle = {
	levels: [
		{ value: 0, color: WHITE, on: true },
		{ value: 0.236, color: "#a33440", on: false },
		{ value: 0.382, color: "#a8660f", on: false },
		{ value: 0.826, color: WHITE, on: true },
		{ value: 0.618, color: WHITE, on: true },
		{ value: 0.786, color: WHITE, on: true },
		{ value: 1, color: WHITE, on: true },
		{ value: 1.618, color: "#2c48a8", on: false },
		{ value: 2.618, color: "#a33440", on: false },
		{ value: 3.618, color: "#6a2c91", on: false },
		{ value: 4.236, color: "#8f1f4c", on: false },
		{ value: 1.272, color: "#a8660f", on: false },
		{ value: 1.414, color: "#a33440", on: false },
		{ value: 2.272, color: "#a8660f", on: false },
		{ value: 2.414, color: "#3f7d3a", on: false },
		{ value: 2, color: "#1f6b5c", on: false },
		{ value: 3, color: "#14838f", on: false },
		{ value: 3.272, color: "#555555", on: false },
		{ value: 3.414, color: "#2c48a8", on: false },
		{ value: 4, color: "#a33440", on: false },
		{ value: 4.272, color: "#6a2c91", on: false },
		{ value: 4.414, color: "#8f1f4c", on: false },
		{ value: 4.618, color: "#a8660f", on: false },
		{ value: 4.764, color: "#1f6b5c", on: false },
	],
	trendLine: true,
	background: false,
	reverse: false,
	prices: false,
	levelLabels: false,
	labelSide: "left",
};

/** A fib level's price. TradingView's convention: drawn from A to B, level
 *  0 sits at B and 1 at A (a low→high draw reads retracements down from
 *  the high); `reverse` swaps the ends. */
export function fibLevelPrice(a: DrawPoint, b: DrawPoint, value: number, reverse = false): number {
	const [from, to] = reverse ? [b, a] : [a, b];
	return to.price + (from.price - to.price) * value;
}

/** The chart's identity: a stable hash of its data (FNV-1a, 32-bit hex). */
export function chartKey(source: string): string {
	let h = 0x811c9dc5;
	const s = source.trim();
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `c${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// ─── validation (the server never stores a shape it can't draw) ─────────────

export const MAX_DRAWINGS = 100;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const point = (v: unknown): DrawPoint | null => {
	const p = (v ?? {}) as Record<string, unknown>;
	return finite(p.bar) && finite(p.price) ? { bar: p.bar, price: p.price } : null;
};
const color = (v: unknown): PaletteColor => (PALETTE_COLORS.includes(v as PaletteColor) ? (v as PaletteColor) : "yellow");
const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
const hex = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

function fibStyle(v: unknown): FibStyle {
	const s = (v ?? {}) as Record<string, unknown>;
	const levels = Array.isArray(s.levels)
		? s.levels
				.map((l) => (l ?? {}) as Record<string, unknown>)
				.filter((l) => finite(l.value))
				.slice(0, 40)
				.map((l) => ({ value: l.value as number, color: hex(l.color, WHITE), on: l.on === true }))
		: DEFAULT_FIB_STYLE.levels;
	return {
		levels,
		trendLine: s.trendLine !== false,
		background: s.background === true,
		reverse: s.reverse === true,
		prices: s.prices === true,
		levelLabels: s.levelLabels === true,
		labelSide: s.labelSide === "right" ? "right" : "left",
	};
}

/** Sanitize a client-sent drawing list (unknown shapes are dropped). */
export function sanitizeDrawings(raw: unknown): Drawing[] {
	if (!Array.isArray(raw)) return [];
	const out: Drawing[] = [];
	for (const r of raw.slice(0, MAX_DRAWINGS)) {
		const d = (r ?? {}) as Record<string, unknown>;
		const id = typeof d.id === "string" && d.id ? d.id.slice(0, 40) : null;
		if (!id) continue;
		if (d.kind === "hline") {
			if (finite(d.price)) out.push({ id, kind: "hline", price: d.price, color: color(d.color), dashed: d.dashed === true, name: text(d.name) });
			continue;
		}
		const a = point(d.a);
		const b = point(d.b);
		if (!a || !b) continue;
		if (d.kind === "fib") out.push({ id, kind: "fib", a, b, style: fibStyle(d.style) });
		else if (d.kind === "rect") out.push({ id, kind: "rect", a, b, color: color(d.color), text: text(d.text, 500) });
		else if (d.kind === "trend") out.push({ id, kind: "trend", a, b, color: color(d.color), dashed: d.dashed === true, name: text(d.name) });
	}
	return out;
}

/** Validate a PUT body: one chart's entry. */
export function parseDrawingsPut(body: unknown): { ok: true; key: string; entry: ChartDrawingsEntry } | { ok: false; error: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	if (typeof b.key !== "string" || !/^c[0-9a-f]{8}$/.test(b.key)) return { ok: false, error: "Missing chart key" };
	const labels = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === "string").slice(0, 2000).map((l) => l.slice(0, 40)) : [];
	return { ok: true, key: b.key, entry: { title: text(b.title), labels, drawings: sanitizeDrawings(b.drawings) } };
}

// ─── the teacher's summary ──────────────────────────────────────────────────

const p2 = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, "");

function barName(labels: string[], bar: number): string {
	const i = Math.round(bar);
	if (!labels.length) return `bar ${i + 1}`;
	if (i < 0) return `${-i} bar${i === -1 ? "" : "s"} before ${labels[0]}`;
	if (i >= labels.length) return `${labels[labels.length - 1]}+${i - labels.length + 1}`;
	return labels[i]!;
}

/** One line per drawing, in plain words with bar labels and prices. */
export function describeDrawing(d: Drawing, labels: string[]): string {
	const name = (n?: string) => (n ? ` "${n}"` : "");
	switch (d.kind) {
		case "hline":
			return `horizontal line${name(d.name)} (${d.color}) at ${p2(d.price)}`;
		case "trend":
			return `trend line${name(d.name)} (${d.color}) from ${barName(labels, d.a.bar)} ${p2(d.a.price)} to ${barName(labels, d.b.bar)} ${p2(d.b.price)}`;
		case "rect": {
			const lo = Math.min(d.a.price, d.b.price);
			const hi = Math.max(d.a.price, d.b.price);
			const [l, r] = d.a.bar <= d.b.bar ? [d.a, d.b] : [d.b, d.a];
			return `rectangle${d.text ? ` "${d.text}"` : ""} (${d.color}) ${p2(lo)}–${p2(hi)} over ${barName(labels, l.bar)}–${barName(labels, r.bar)}`;
		}
		case "fib": {
			const levels = d.style.levels
				.filter((l) => l.on)
				.sort((x, y) => x.value - y.value)
				.map((l) => `${l.value} → ${p2(fibLevelPrice(d.a, d.b, l.value, d.style.reverse))}`)
				.join(", ");
			return `fib retracement from ${barName(labels, d.a.bar)} ${p2(d.a.price)} to ${barName(labels, d.b.bar)} ${p2(d.b.price)}${levels ? ` — ${levels}` : ""}`;
		}
	}
}

/** A content hash of one chart's drawings (what "changed" compares). */
export function drawingsDigest(drawings: Drawing[]): string {
	return chartKey(JSON.stringify(drawings));
}

type MarkerDetails = { digests: Record<string, string>; count: number };

/** The last digests the teacher saw, from the newest chart-drawings marker. */
function lastShared(messages: readonly LhMessage[]): Record<string, string> {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as Partial<LhMarkerMessage>;
		if (m.role === "custom" && m.customType === "chart-drawings") return { ...((m.details as MarkerDetails | undefined)?.digests ?? {}) };
	}
	return {};
}

/** Has the teacher ever been shown drawings on this chart? (An emptied
 *  chart the teacher never saw simply drops out of the record.) */
export function wasShared(messages: readonly LhMessage[], key: string): boolean {
	return lastShared(messages)[key] !== undefined;
}

/**
 * The marker for the learner's next turn: the drawings added or changed
 * since the teacher last saw them (a chart cleared of drawings says so),
 * or null when nothing changed. `details.digests` carries the full state
 * forward, so the next comparison reads the record alone.
 */
export function chartDrawingsMarker(
	record: { messages: readonly LhMessage[]; chartDrawings?: ChartDrawingsMap },
	id: string,
	now = Date.now(),
): LhMarkerMessage | null {
	const map = record.chartDrawings ?? {};
	const seen = lastShared(record.messages);
	const digests: Record<string, string> = { ...seen };
	const sections: string[] = [];
	let count = 0;
	for (const [key, entry] of Object.entries(map)) {
		const digest = drawingsDigest(entry.drawings);
		const before = seen[key];
		if (before === digest || (before === undefined && entry.drawings.length === 0)) continue;
		digests[key] = digest;
		const title = entry.title ? `"${entry.title}"` : "a chart";
		if (!entry.drawings.length) {
			sections.push(`On ${title}: the learner removed all their drawings.`);
			continue;
		}
		count += entry.drawings.length;
		sections.push(`On ${title}:\n${entry.drawings.map((d) => `- ${describeDrawing(d, entry.labels)}`).join("\n")}`);
	}
	if (!sections.length) return null;
	return {
		id,
		role: "custom",
		customType: "chart-drawings",
		content: `[Learner's chart drawings — what they drew on the lesson's charts; the current set per chart]\n${sections.join("\n\n")}`,
		display: true,
		details: { digests, count } satisfies MarkerDetails,
		timestamp: now,
	};
}
