"use client";

/**
 * Learner chart drawings — the UI (owner, 2026-11-04; the data model and
 * the teacher summary are src/core/chart-drawings.ts).
 *
 * - DrawingsProvider (the chat page) holds record.chartDrawings and saves
 *   one chart's list per change (debounced PUT /api/chats/[id]/drawings).
 * - DrawingLayer: an SVG over the chart's plot area converting data ↔
 *   pixels with the chart's own API, so drawings stay put through zoom and
 *   pan. Read-only inline; in the full-screen chart it is the editor:
 *   tool modes, click-click or drag to place, select → handles to reshape,
 *   drag to move, the edit bar (palette, text/name, dashed), the fib
 *   settings (TradingView's level list), Delete, ⌘Z.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	DEFAULT_FIB_STYLE,
	fibLevelPrice,
	PALETTE,
	PALETTE_COLORS,
	type ChartDrawingsEntry,
	type ChartDrawingsMap,
	type DrawPoint,
	type Drawing,
	type DrawingKind,
	type FibStyle,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsIcon, Trash2Icon, XIcon } from "lucide-react";

type ChartApi = import("lightweight-charts").IChartApi;
type SeriesApi = import("lightweight-charts").ISeriesApi<"Candlestick">;

// ─── persistence ────────────────────────────────────────────────────────────

type DrawingsCtx = {
	get: (key: string) => Drawing[];
	save: (key: string, entry: ChartDrawingsEntry) => void;
};
const Ctx = createContext<DrawingsCtx | null>(null);

/** The chat page's drawing store: record.chartDrawings in state, each
 *  chart's list PUT on change (400ms debounce per chart). */
export function DrawingsProvider({ chatId, initial, children }: { chatId: string; initial?: ChartDrawingsMap; children: ReactNode }) {
	const [map, setMap] = useState<ChartDrawingsMap>(initial ?? {});
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const save = useCallback(
		(key: string, entry: ChartDrawingsEntry) => {
			setMap((m) => ({ ...m, [key]: entry }));
			const t = timers.current.get(key);
			if (t) clearTimeout(t);
			timers.current.set(
				key,
				setTimeout(() => {
					timers.current.delete(key);
					void fetch(`/api/chats/${encodeURIComponent(chatId)}/drawings`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ key, ...entry }),
						keepalive: true,
					}).catch(() => {});
				}, 400),
			);
		},
		[chatId],
	);
	const value = useMemo<DrawingsCtx>(() => ({ get: (key) => map[key]?.drawings ?? [], save }), [map, save]);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One chart's drawings + saver (null outside a chat — no drawing there). */
export function useChartDrawings(key: string, title: string | undefined, labels: string[]) {
	const ctx = useContext(Ctx);
	if (!ctx) return null;
	return {
		drawings: ctx.get(key),
		set: (drawings: Drawing[]) => ctx.save(key, { title, labels, drawings }),
	};
}

// ─── geometry ───────────────────────────────────────────────────────────────

type Geo = {
	x: (bar: number) => number | null;
	y: (price: number) => number | null;
	toData: (x: number, y: number) => DrawPoint | null;
	width: number;
	height: number;
};

function geometry(chart: ChartApi, series: SeriesApi): Geo {
	const ts = chart.timeScale();
	const pane = chart.paneSize(0);
	return {
		x: (bar) => ts.logicalToCoordinate(bar as never),
		y: (price) => series.priceToCoordinate(price),
		toData: (x, y) => {
			const bar = ts.coordinateToLogical(x);
			const price = series.coordinateToPrice(y);
			return bar === null || price === null ? null : { bar: Number(bar), price: Number(price) };
		},
		width: pane.width,
		height: pane.height,
	};
}

const hexA = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
const colorOf = (d: Drawing) => (d.kind === "fib" ? "#e6e6e6" : PALETTE[d.color]);
const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2));
const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ─── the layer ──────────────────────────────────────────────────────────────

export type Tool = "select" | DrawingKind;

export function DrawingLayer({
	chart,
	series,
	drawings,
	editable = false,
	tool = "select",
	onToolDone,
	onChange,
	selected,
	onSelect,
}: {
	chart: React.RefObject<ChartApi | null>;
	series: React.RefObject<SeriesApi | null>;
	drawings: Drawing[];
	editable?: boolean;
	tool?: Tool;
	onToolDone?: () => void;
	onChange?: (next: Drawing[]) => void;
	selected?: string | null;
	onSelect?: (id: string | null) => void;
}) {
	const [, setTick] = useState(0);
	const svgRef = useRef<SVGSVGElement>(null);
	// The draft while placing: the first anchor, the moving second one.
	const [draft, setDraft] = useState<Drawing | null>(null);
	const drag = useRef<{ id: string; handle: "a" | "b" | "body"; from: DrawPoint; original: Drawing } | null>(null);
	const downAt = useRef<{ x: number; y: number } | null>(null);

	// Redraw: every frame while editing (axis drags have no event), on view
	// changes otherwise.
	useEffect(() => {
		if (editable) {
			let raf = 0;
			const loop = () => {
				setTick((t) => t + 1);
				raf = requestAnimationFrame(loop);
			};
			raf = requestAnimationFrame(loop);
			return () => cancelAnimationFrame(raf);
		}
		let cleanup = () => {};
		const attach = () => {
			const c = chart.current;
			if (!c) return false;
			const bump = () => setTick((t) => t + 1);
			c.timeScale().subscribeVisibleLogicalRangeChange(bump);
			c.timeScale().subscribeSizeChange(bump);
			cleanup = () => {
				c.timeScale().unsubscribeVisibleLogicalRangeChange(bump);
				c.timeScale().unsubscribeSizeChange(bump);
			};
			bump();
			return true;
		};
		const poll = setInterval(() => attach() && clearInterval(poll), 100); // the chart mounts async
		return () => {
			clearInterval(poll);
			cleanup();
		};
	}, [editable, chart]);

	const c = chart.current;
	const s = series.current;
	if (!c || !s) return null;
	const geo = geometry(c, s);

	const local = (e: React.PointerEvent) => {
		const r = svgRef.current!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const placing = editable && tool !== "select";

	const onPointerDown = (e: React.PointerEvent) => {
		if (!placing) return;
		e.preventDefault();
		const p = local(e);
		const pt = geo.toData(p.x, p.y);
		if (!pt) return;
		(e.target as Element).setPointerCapture?.(e.pointerId);
		if (tool === "hline") {
			const d: Drawing = { id: newId(), kind: "hline", price: pt.price, color: "blue" };
			onChange?.([...drawings, d]);
			onSelect?.(d.id);
			onToolDone?.();
			return;
		}
		if (draft) {
			// The second click of a click-click placement.
			finish({ ...draft, b: pt } as Drawing);
			return;
		}
		downAt.current = p;
		setDraft(makeDraft(tool, pt));
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const p = local(e);
		const pt = geo.toData(p.x, p.y);
		if (!pt) return;
		if (draft) {
			setDraft({ ...draft, b: pt } as Drawing);
			return;
		}
		const dr = drag.current;
		if (!dr) return;
		const dBar = pt.bar - dr.from.bar;
		const dPrice = pt.price - dr.from.price;
		const o = dr.original;
		let next: Drawing;
		if (o.kind === "hline") next = { ...o, price: o.price + dPrice };
		else if (dr.handle === "body") next = { ...o, a: shift(o.a, dBar, dPrice), b: shift(o.b, dBar, dPrice) } as Drawing;
		else next = { ...o, [dr.handle]: pt } as Drawing;
		onChange?.(drawings.map((d) => (d.id === o.id ? next : d)));
	};
	const onPointerUp = (e: React.PointerEvent) => {
		if (draft && downAt.current) {
			const p = local(e);
			const moved = Math.hypot(p.x - downAt.current.x, p.y - downAt.current.y) > 5;
			downAt.current = null;
			if (moved) finish(draft); // a drag placement; a click waits for the second click
		}
		drag.current = null;
	};
	const finish = (d: Drawing) => {
		setDraft(null);
		downAt.current = null;
		onChange?.([...drawings, d]);
		onSelect?.(d.id);
		onToolDone?.();
	};
	const grab = (e: React.PointerEvent, d: Drawing, handle: "a" | "b" | "body") => {
		if (!editable || placing) return;
		e.stopPropagation();
		e.preventDefault();
		const p = local(e);
		const pt = geo.toData(p.x, p.y);
		if (!pt) return;
		onSelect?.(d.id);
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		drag.current = { id: d.id, handle, from: pt, original: d };
	};

	const shown = draft ? [...drawings, draft] : drawings;
	return (
		<svg
			ref={svgRef}
			data-testid="drawing-layer"
			width={geo.width}
			height={geo.height}
			className="absolute top-0 left-0 overflow-hidden"
			// Above the chart's own canvases (they stack with z-index); clicks
			// still fall through to the chart except on shapes / while placing.
			style={{ zIndex: 5, pointerEvents: placing ? "all" : "none", cursor: placing ? "crosshair" : undefined }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
		>
			{shown.map((d) => (
				<Shape
					key={d.id}
					d={d}
					geo={geo}
					selected={editable && selected === d.id}
					interactive={editable && !placing}
					onGrab={grab}
				/>
			))}
		</svg>
	);
}

function shift(p: DrawPoint, dBar: number, dPrice: number): DrawPoint {
	return { bar: p.bar + dBar, price: p.price + dPrice };
}

function makeDraft(kind: Exclude<Tool, "select" | "hline">, a: DrawPoint): Drawing {
	const id = newId();
	if (kind === "fib") return { id, kind, a, b: a, style: loadFibDefault() };
	if (kind === "rect") return { id, kind, a, b: a, color: "yellow" };
	return { id, kind: "trend", a, b: a, color: "blue" };
}

function Shape({
	d,
	geo,
	selected,
	interactive,
	onGrab,
}: {
	d: Drawing;
	geo: Geo;
	selected: boolean;
	interactive: boolean;
	onGrab: (e: React.PointerEvent, d: Drawing, handle: "a" | "b" | "body") => void;
}) {
	const pe = interactive ? "visiblePainted" : "none";
	const color = colorOf(d);
	const handle = (h: "a" | "b", x: number | null, y: number | null) =>
		x === null || y === null ? null : (
			<circle
				key={h}
				cx={x}
				cy={y}
				r={4.5}
				fill="var(--background)"
				stroke={color}
				strokeWidth={1.5}
				style={{ pointerEvents: interactive ? "all" : "none", cursor: "move" }}
				onPointerDown={(e) => onGrab(e, d, h)}
			/>
		);

	if (d.kind === "hline") {
		const y = geo.y(d.price);
		if (y === null) return null;
		return (
			<g data-drawing={d.id}>
				<line x1={0} x2={geo.width} y1={y} y2={y} stroke="transparent" strokeWidth={10} style={{ pointerEvents: pe === "none" ? "none" : "stroke", cursor: "move" }} onPointerDown={(e) => onGrab(e, d, "body")} />
				<line x1={0} x2={geo.width} y1={y} y2={y} stroke={color} strokeWidth={1.5} strokeDasharray={d.dashed ? "6 4" : undefined} pointerEvents="none" />
				{d.name && (
					<text x={geo.width - 6} y={y - 5} textAnchor="end" fill={color} fontSize={11} pointerEvents="none">
						{d.name}
					</text>
				)}
				{selected && handle("a", geo.width / 2, y)}
			</g>
		);
	}

	const xa = geo.x(d.a.bar);
	const ya = geo.y(d.a.price);
	const xb = geo.x(d.b.bar);
	const yb = geo.y(d.b.price);
	if (xa === null || ya === null || xb === null || yb === null) return null;

	if (d.kind === "trend") {
		return (
			<g data-drawing={d.id}>
				<line x1={xa} y1={ya} x2={xb} y2={yb} stroke="transparent" strokeWidth={10} style={{ pointerEvents: pe === "none" ? "none" : "stroke", cursor: "move" }} onPointerDown={(e) => onGrab(e, d, "body")} />
				<line x1={xa} y1={ya} x2={xb} y2={yb} stroke={color} strokeWidth={2} strokeDasharray={d.dashed ? "6 4" : undefined} pointerEvents="none" />
				{d.name && (
					<text x={xb + 6} y={yb - 6} fill={color} fontSize={11} pointerEvents="none">
						{d.name}
					</text>
				)}
				{selected && [handle("a", xa, ya), handle("b", xb, yb)]}
			</g>
		);
	}

	if (d.kind === "rect") {
		const x = Math.min(xa, xb);
		const y = Math.min(ya, yb);
		const w = Math.abs(xb - xa);
		const h = Math.abs(yb - ya);
		return (
			<g data-drawing={d.id}>
				<rect x={x} y={y} width={w} height={h} fill={hexA(color, 0.14)} stroke={hexA(color, 0.75)} strokeWidth={1} style={{ pointerEvents: pe === "none" ? "none" : "all", cursor: "move" }} onPointerDown={(e) => onGrab(e, d, "body")} />
				{d.text && w > 20 && h > 12 && (
					<foreignObject x={x} y={y} width={w} height={h} pointerEvents="none">
						<div className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-center text-[11px] leading-tight" style={{ color }}>
							{d.text}
						</div>
					</foreignObject>
				)}
				{selected && [handle("a", xa, ya), handle("b", xb, yb)]}
			</g>
		);
	}

	// fib: horizontal levels across the two anchors' span (TradingView "Don't extend").
	const s = d.style;
	const left = Math.min(xa, xb);
	const right = Math.max(xa, xb);
	const levels = s.levels.filter((l) => l.on).map((l) => ({ ...l, price: fibLevelPrice(d.a, d.b, l.value, s.reverse) }));
	const sorted = [...levels].sort((p, q) => p.price - q.price);
	return (
		<g data-drawing={d.id}>
			<rect
				x={left}
				y={Math.min(ya, yb)}
				width={Math.max(1, right - left)}
				height={Math.max(1, Math.abs(yb - ya))}
				fill="transparent"
				style={{ pointerEvents: pe === "none" ? "none" : "all", cursor: "move" }}
				onPointerDown={(e) => onGrab(e, d, "body")}
			/>
			{s.background &&
				sorted.slice(1).map((l, i) => {
					const y1 = geo.y(sorted[i]!.price);
					const y2 = geo.y(l.price);
					return y1 === null || y2 === null ? null : (
						<rect key={`bg${i}`} x={left} y={Math.min(y1, y2)} width={right - left} height={Math.abs(y2 - y1)} fill={hexA(l.color, 0.08)} pointerEvents="none" />
					);
				})}
			{levels.map((l) => {
				const y = geo.y(l.price);
				if (y === null) return null;
				const label = [s.levelLabels ? String(l.value) : "", s.prices ? `(${fmt(l.price)})` : ""].filter(Boolean).join(" ");
				return (
					<g key={l.value} pointerEvents="none">
						<line x1={left} x2={right} y1={y} y2={y} stroke={l.color} strokeWidth={1} />
						{label && (
							<text x={s.labelSide === "left" ? left - 4 : right + 4} y={y + 3.5} textAnchor={s.labelSide === "left" ? "end" : "start"} fill={l.color} fontSize={10}>
								{label}
							</text>
						)}
					</g>
				);
			})}
			{s.trendLine && <line x1={xa} y1={ya} x2={xb} y2={yb} stroke="#8d8d8d" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />}
			{selected && [handle("a", xa, ya), handle("b", xb, yb)]}
		</g>
	);
}

// ─── the fib template (this device) ─────────────────────────────────────────

const FIB_KEY = "lh:fib-default";

function loadFibDefault(): FibStyle {
	try {
		const raw = window.localStorage.getItem(FIB_KEY);
		return raw ? { ...DEFAULT_FIB_STYLE, ...(JSON.parse(raw) as FibStyle) } : DEFAULT_FIB_STYLE;
	} catch {
		return DEFAULT_FIB_STYLE;
	}
}

function saveFibDefault(style: FibStyle): void {
	try {
		window.localStorage.setItem(FIB_KEY, JSON.stringify(style));
	} catch {
		/* storage unavailable */
	}
}

// ─── the edit bar + fib settings (full screen) ──────────────────────────────

export function DrawingEditBar({ drawing, onChange, onDelete }: { drawing: Drawing; onChange: (d: Drawing) => void; onDelete: () => void }) {
	const [fibOpen, setFibOpen] = useState(false);
	return (
		<div data-testid="drawing-edit-bar" className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 shadow-lg">
			{drawing.kind !== "fib" &&
				PALETTE_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						title={c}
						aria-label={`Color ${c}`}
						onClick={() => onChange({ ...drawing, color: c } as Drawing)}
						className={cn("size-4 rounded-full border", drawing.color === c ? "border-foreground ring-1 ring-foreground" : "border-transparent")}
						style={{ background: PALETTE[c] }}
					/>
				))}
			{drawing.kind === "rect" && (
				<input
					value={drawing.text ?? ""}
					onChange={(e) => onChange({ ...drawing, text: e.target.value })}
					placeholder="Text in box"
					aria-label="Text in box"
					className="h-6 w-44 rounded border bg-background px-1.5 text-xs outline-none"
				/>
			)}
			{(drawing.kind === "trend" || drawing.kind === "hline") && (
				<>
					<input
						value={drawing.name ?? ""}
						onChange={(e) => onChange({ ...drawing, name: e.target.value })}
						placeholder="Name this line"
						aria-label="Line name"
						className="h-6 w-40 rounded border bg-background px-1.5 text-xs outline-none"
					/>
					<button
						type="button"
						onClick={() => onChange({ ...drawing, dashed: !drawing.dashed })}
						className="h-6 rounded border px-1.5 text-xs text-muted-foreground hover:text-foreground"
					>
						{drawing.dashed ? "Dashed" : "Solid"}
					</button>
				</>
			)}
			{drawing.kind === "fib" && (
				<button type="button" onClick={() => setFibOpen(true)} className="flex h-6 items-center gap-1 rounded border px-1.5 text-xs text-muted-foreground hover:text-foreground">
					<SettingsIcon className="size-3.5" /> Fib settings
				</button>
			)}
			<button type="button" onClick={onDelete} aria-label="Delete drawing" title="Delete (⌫)" className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive">
				<Trash2Icon className="size-3.5" />
			</button>
			{fibOpen && drawing.kind === "fib" && (
				<FibSettings style={drawing.style} onChange={(style) => onChange({ ...drawing, style })} onClose={() => setFibOpen(false)} />
			)}
		</div>
	);
}

function FibSettings({ style, onChange, onClose }: { style: FibStyle; onChange: (s: FibStyle) => void; onClose: () => void }) {
	const setLevel = (i: number, patch: Partial<FibStyle["levels"][number]>) =>
		onChange({ ...style, levels: style.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
	const check = (label: string, key: "trendLine" | "background" | "reverse" | "prices" | "levelLabels") => (
		<label className="flex items-center gap-2 text-sm">
			<input type="checkbox" checked={style[key]} onChange={(e) => onChange({ ...style, [key]: e.target.checked })} />
			{label}
		</label>
	);
	return createPortal(
		<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onPointerDown={onClose}>
			<div
				data-testid="fib-settings"
				role="dialog"
				aria-label="Fib retracement settings"
				className="max-h-[85vh] w-[26rem] overflow-y-auto rounded-xl border bg-card p-4 shadow-2xl"
				onPointerDown={(e) => e.stopPropagation()}
			>
				<div className="mb-3 flex items-center justify-between">
					<span className="font-medium">Fib retracement</span>
					<button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
						<XIcon className="size-4" />
					</button>
				</div>
				<div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
					{style.levels.map((l, i) => (
						<div key={i} className="flex items-center gap-1.5">
							<input type="checkbox" checked={l.on} aria-label={`Level ${l.value}`} onChange={(e) => setLevel(i, { on: e.target.checked })} />
							<input
								type="number"
								step="0.001"
								value={l.value}
								onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setLevel(i, { value: e.target.valueAsNumber })}
								className={cn("h-7 w-20 rounded border bg-background px-1.5 text-sm outline-none", !l.on && "opacity-50")}
							/>
							<input type="color" value={l.color} aria-label={`Level ${l.value} color`} onChange={(e) => setLevel(i, { color: e.target.value })} className="h-7 w-8 rounded border bg-transparent" />
						</div>
					))}
				</div>
				<div className="flex flex-col gap-1.5 border-t pt-3">
					{check("Trend line", "trendLine")}
					{check("Background", "background")}
					{check("Reverse", "reverse")}
					{check("Prices", "prices")}
					{check("Levels", "levelLabels")}
					<label className="flex items-center gap-2 text-sm">
						Labels
						<select
							value={style.labelSide}
							onChange={(e) => onChange({ ...style, labelSide: e.target.value === "right" ? "right" : "left" })}
							className="h-7 rounded border bg-background px-1 text-sm"
						>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
					</label>
				</div>
				<div className="mt-4 flex justify-between">
					<button type="button" onClick={() => saveFibDefault(style)} className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" title="New fibs on this device start from these settings">
						Save as default
					</button>
					<button type="button" onClick={onClose} className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground">
						Done
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
