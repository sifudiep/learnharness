"use client";

/**
 * The ```chart fence rendered (stock-chart wave, owner 2026-11-01): real
 * candlesticks via TradingView Lightweight Charts (Apache-2.0 — its
 * attribution logo stays on, as the license asks). The spec is parsed and
 * validated in src/core/chart-spec.ts; this file only draws.
 *
 * - Bars sit on a synthetic, evenly spaced time axis (index → time) and
 *   the axis/crosshair print each bar's own label — dates and "Mon" alike,
 *   with no weekend gaps.
 * - Levels are price lines (label on the axis), marks are arrows at a
 *   bar's high/low, lines are two-point line series (trendlines).
 * - Inline, the mouse wheel stays the transcript's; ⌘/Ctrl + wheel (and
 *   pinch) zooms, drag pans, axis-drag stretches, double-click an axis
 *   resets. The expand button opens a full-screen view with TradingView
 *   navigation (wheel zoom, zoom out into empty space, +/−/reset).
 * - Colors follow the app theme tokens and re-apply on a theme flip.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MaximizeIcon, RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { parseChartSpec, type ChartBar, type ChartLineStyle, type ChartSpec, type ChartTone } from "@/src/core";

const DAY = 86_400;
const HEIGHT = 320;
/** Candle pitch at the initial fit: a short series stays readable candles (not slabs) —
 *  the chart shrinks to fit its bars instead of stretching them. */
const MAX_BAR_SPACING = 30;
const PRICE_SCALE_ROOM = 90;
/** Empty bar slots after the last candle: room for its mark/label text,
 *  which the price axis would otherwise clip. */
const RIGHT_ROOM = 3;

const TONE_COLORS: Record<Exclude<ChartTone, "neutral">, string> = {
	up: "#22c55e",
	down: "#ef4444",
	accent: "#f59e0b",
};

type Theme = { text: string; muted: string; grid: string };

function token(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return /^(#|rgb)/.test(v) ? v : fallback;
}

function readTheme(): Theme {
	return {
		text: token("--foreground", "#e6e6e6"),
		muted: token("--muted-foreground", "#8d8d8d"),
		grid: token("--border", "#434343"),
	};
}

function toneColor(tone: ChartTone, theme: Theme): string {
	return tone === "neutral" ? theme.muted : TONE_COLORS[tone];
}

/** The synthetic time for bar i (evenly spaced). */
function timeOf(i: number): number {
	return (i + 1) * DAY;
}

function formatPrice(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

export function StockChart({
	source,
	incomplete,
	corner,
	height = HEIGHT,
}: {
	source: string;
	incomplete: boolean;
	corner?: ReactNode;
	/** Plot height in px (the answer dialog pins a compact copy). */
	height?: number;
}) {
	const parsed = useMemo(() => parseChartSpec(source), [source]);
	if (!parsed.ok) {
		// Still streaming: the JSON is partial by nature — a quiet skeleton,
		// never a doomed error.
		if (incomplete) return <ChartSkeleton height={height} />;
		return <ChartError error={parsed.error} source={source} />;
	}
	return <ChartCanvas spec={parsed.spec} corner={corner} height={height} />;
}

function ChartSkeleton({ height }: { height: number }) {
	return (
		<div data-testid="md-chart" data-lh-chart="" className="my-4 flex items-center justify-center p-4" style={{ height }} aria-busy="true">
			<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
		</div>
	);
}

function ChartError({ error, source }: { error: string; source: string }) {
	return (
		<div data-testid="md-chart-error" data-lh-chart="" className="my-4 rounded-md border border-destructive/40 p-3 text-xs">
			<div className="font-medium text-destructive">{error}</div>
			<details className="mt-2 text-muted-foreground">
				<summary className="cursor-pointer select-none">Chart source</summary>
				<pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono">{source}</pre>
			</details>
		</div>
	);
}

type Mode = "inline" | "full";
type ChartApi = import("lightweight-charts").IChartApi;

/** Zoom the time axis by `factor` (<1 in, >1 out) around a logical anchor. */
function zoomBy(chart: ChartApi, factor: number, anchor?: number): void {
	const ts = chart.timeScale();
	const r = ts.getVisibleLogicalRange();
	if (!r) return;
	const c = anchor ?? (r.from + r.to) / 2;
	ts.setVisibleLogicalRange({ from: c - (c - r.from) * factor, to: c + (r.to - c) * factor });
}

function panBy(chart: ChartApi, share: number): void {
	const ts = chart.timeScale();
	const r = ts.getVisibleLogicalRange();
	if (!r) return;
	const d = (r.to - r.from) * share;
	ts.setVisibleLogicalRange({ from: r.from + d, to: r.to + d });
}

function resetView(chart: ChartApi): void {
	chart.timeScale().fitContent();
	chart.timeScale().applyOptions({ rightOffset: RIGHT_ROOM }); // fitContent zeroes it
	chart.priceScale("right").applyOptions({ autoScale: true });
}

/**
 * Draw the spec into `holder` — one routine for both modes:
 * - inline (the conversation, the answer dialog): the plain wheel stays the
 *   page's; ⌘/Ctrl + wheel (and the trackpad pinch, which arrives as
 *   Ctrl + wheel) zooms around the pointer (owner, 2026-11-04).
 * - full (the expanded view): TradingView-style — the wheel zooms, drag
 *   pans, axis drags stretch, and the view may zoom out past the data
 *   into empty space.
 */
function useChart(
	holder: React.RefObject<HTMLDivElement | null>,
	spec: ChartSpec,
	mode: Mode,
	onHover: (bar: ChartBar) => void,
): React.RefObject<ChartApi | null> {
	const api = useRef<ChartApi | null>(null);
	const hoverRef = useRef(onHover);
	hoverRef.current = onHover;
	useEffect(() => {
		const el = holder.current;
		if (!el) return;
		let disposed = false;
		let cleanup = () => {};
		void import("lightweight-charts").then((lc) => {
			if (disposed) return;
			const full = mode === "full";
			const theme = readTheme();
			const labelOf = (time: unknown) => spec.bars[Math.round(Number(time) / DAY) - 1]?.t ?? "";
			const lineStyle = (s: ChartLineStyle) =>
				s === "dashed" ? lc.LineStyle.Dashed : s === "dotted" ? lc.LineStyle.Dotted : lc.LineStyle.Solid;
			const chart = lc.createChart(el, {
				autoSize: true,
				layout: {
					background: { type: lc.ColorType.Solid, color: "transparent" },
					textColor: theme.muted,
					fontFamily: "inherit",
					attributionLogo: true, // the Lightweight Charts license's attribution
				},
				grid: {
					vertLines: { color: `${theme.grid}55` },
					horzLines: { color: `${theme.grid}55` },
				},
				rightPriceScale: { borderColor: theme.grid },
				timeScale: {
					borderColor: theme.grid,
					tickMarkFormatter: (time: unknown) => labelOf(time),
					// Inline stays on the data; full screen may wander into empty space.
					fixLeftEdge: !full,
					rightOffset: RIGHT_ROOM,
				},
				localization: { timeFormatter: (time: unknown) => labelOf(time), priceFormatter: formatPrice },
				crosshair: { mode: lc.CrosshairMode.Normal },
				handleScroll: { mouseWheel: full, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: full },
				handleScale: { mouseWheel: full, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
			});
			api.current = chart;
			const candles = chart.addSeries(lc.CandlestickSeries, {
				upColor: TONE_COLORS.up,
				downColor: TONE_COLORS.down,
				wickUpColor: TONE_COLORS.up,
				wickDownColor: TONE_COLORS.down,
				borderVisible: false,
				priceLineVisible: false,
				lastValueVisible: false,
			});
			candles.setData(
				spec.bars.map((b, i) => ({ time: timeOf(i) as never, open: b.o, high: b.h, low: b.l, close: b.c })),
			);
			for (const level of spec.levels) {
				candles.createPriceLine({
					price: level.price,
					color: toneColor(level.tone, theme),
					lineWidth: 1,
					lineStyle: lineStyle(level.style),
					axisLabelVisible: true,
					title: level.label ?? "",
				});
			}
			const index = new Map(spec.bars.map((b, i) => [b.t, i]));
			lc.createSeriesMarkers(
				candles,
				spec.marks
					.map((m) => ({
						time: timeOf(index.get(m.t)!) as never,
						position: m.at === "low" ? ("belowBar" as const) : ("aboveBar" as const),
						shape: m.at === "low" ? ("arrowUp" as const) : ("arrowDown" as const),
						color: toneColor(m.tone, theme),
						text: m.text ?? "",
					}))
					.sort((a, b) => Number(a.time) - Number(b.time)),
			);
			for (const line of spec.lines) {
				const series = chart.addSeries(lc.LineSeries, {
					color: toneColor(line.tone, theme),
					lineWidth: 2,
					lineStyle: lineStyle(line.style),
					priceLineVisible: false,
					lastValueVisible: false,
					crosshairMarkerVisible: false,
				});
				series.setData([
					{ time: timeOf(index.get(line.from.t)!) as never, value: line.from.price },
					{ time: timeOf(index.get(line.to.t)!) as never, value: line.to.price },
				]);
				if (line.label) {
					lc.createSeriesMarkers(series, [
						// Below the line's end: bar marks own the space above the candles.
						{ time: timeOf(index.get(line.to.t)!) as never, position: "belowBar", shape: "circle", size: 0.5, color: toneColor(line.tone, theme), text: line.label },
					]);
				}
			}
			resetView(chart);
			// The OHLC legend follows the crosshair; off the chart it shows the last bar.
			chart.subscribeCrosshairMove((param) => {
				const i = param.time === undefined ? spec.bars.length - 1 : Math.round(Number(param.time) / DAY) - 1;
				const bar = spec.bars[i];
				if (bar) hoverRef.current(bar);
			});
			// Inline: ⌘/Ctrl + wheel zooms around the pointer; the plain wheel
			// scrolls the page. (Non-passive so the browser's page zoom stays out.)
			const onWheel = (e: WheelEvent) => {
				if (full || !(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				const x = e.clientX - el.getBoundingClientRect().left;
				zoomBy(chart, Math.exp(e.deltaY * 0.0025), chart.timeScale().coordinateToLogical(x) ?? undefined);
			};
			el.addEventListener("wheel", onWheel, { passive: false });
			// Theme flips (the .dark class / appearance settings) re-color the chart.
			const observer = new MutationObserver(() => {
				const t = readTheme();
				chart.applyOptions({
					layout: { textColor: t.muted },
					grid: { vertLines: { color: `${t.grid}55` }, horzLines: { color: `${t.grid}55` } },
					rightPriceScale: { borderColor: t.grid },
					timeScale: { borderColor: t.grid },
				});
			});
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
			cleanup = () => {
				el.removeEventListener("wheel", onWheel);
				observer.disconnect();
				api.current = null;
				chart.remove();
			};
		});
		return () => {
			disposed = true;
			cleanup();
		};
	}, [holder, spec, mode]);
	return api;
}

function Legend({ spec, bar }: { spec: ChartSpec; bar: ChartBar }) {
	const up = bar.c >= bar.o;
	return (
		<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs">
			{spec.title && <span className="font-ui text-sm text-foreground">{spec.title}</span>}
			<span className="text-muted-foreground" data-testid="md-chart-legend">
				{bar.t} <span className="opacity-70">O</span> {formatPrice(bar.o)} <span className="opacity-70">H</span>{" "}
				{formatPrice(bar.h)} <span className="opacity-70">L</span> {formatPrice(bar.l)}{" "}
				<span className="opacity-70">C</span>{" "}
				<span style={{ color: up ? TONE_COLORS.up : TONE_COLORS.down }}>{formatPrice(bar.c)}</span>
			</span>
		</div>
	);
}

const ICON_BUTTON =
	"flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground";

function ChartCanvas({ spec, corner, height }: { spec: ChartSpec; corner?: ReactNode; height: number }) {
	const holder = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<ChartBar>(spec.bars[spec.bars.length - 1]!);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => setHovered(spec.bars[spec.bars.length - 1]!), [spec]);
	useChart(holder, spec, "inline", setHovered);

	return (
		<div data-testid="md-chart" data-lh-chart="" className="group/md relative my-4">
			<div className="mb-1 pr-16">
				<Legend spec={spec} bar={hovered} />
			</div>
			<div
				ref={holder}
				className="w-full"
				title="⌘/Ctrl + scroll to zoom · drag to pan"
				style={{ height, maxWidth: (spec.bars.length + RIGHT_ROOM) * MAX_BAR_SPACING + PRICE_SCALE_ROOM }}
			/>
			<div className="absolute top-0 right-0 flex items-start gap-0.5">
				{corner}
				<button
					type="button"
					data-testid="md-chart-expand"
					aria-label="Open chart full screen"
					title="Full screen"
					onClick={() => setExpanded(true)}
					className={ICON_BUTTON}
				>
					<MaximizeIcon className="size-3.5" />
				</button>
			</div>
			{expanded && <ChartFullscreen spec={spec} onClose={() => setExpanded(false)} />}
		</div>
	);
}

/** The expanded chart (owner, 2026-11-04): the whole window, TradingView
 *  navigation. Keys while open: + / − zoom, 0 resets, ← / → pan, Esc
 *  closes — claimed in the capture phase so the app's shortcuts (the
 *  reading cursor's arrows, the Esc chain) stay out. */
function ChartFullscreen({ spec, onClose }: { spec: ChartSpec; onClose: () => void }) {
	const holder = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<ChartBar>(spec.bars[spec.bars.length - 1]!);
	const api = useChart(holder, spec, "full", setHovered);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const chart = api.current;
			let used = true;
			if (e.key === "Escape") onClose();
			else if (!chart) used = false;
			else if (e.key === "+" || e.key === "=") zoomBy(chart, 0.8);
			else if (e.key === "-" || e.key === "_") zoomBy(chart, 1.25);
			else if (e.key === "0") resetView(chart);
			else if (e.key === "ArrowLeft") panBy(chart, -0.1);
			else if (e.key === "ArrowRight") panBy(chart, 0.1);
			else used = false;
			if (used) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [api, onClose]);

	return createPortal(
		<div
			data-testid="md-chart-fullscreen"
			data-lh-chart=""
			role="dialog"
			aria-label={spec.title ?? "Chart"}
			className="fixed inset-0 z-[60] flex flex-col bg-background p-4"
		>
			<div className="mb-2 flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<Legend spec={spec} bar={hovered} />
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<button type="button" aria-label="Zoom in" title="Zoom in (+)" className={ICON_BUTTON} onClick={() => api.current && zoomBy(api.current, 0.8)}>
						<ZoomInIcon className="size-4" />
					</button>
					<button type="button" aria-label="Zoom out" title="Zoom out (−)" className={ICON_BUTTON} onClick={() => api.current && zoomBy(api.current, 1.25)}>
						<ZoomOutIcon className="size-4" />
					</button>
					<button type="button" aria-label="Reset view" title="Reset view (0)" className={ICON_BUTTON} onClick={() => api.current && resetView(api.current)}>
						<RotateCcwIcon className="size-4" />
					</button>
					<button type="button" data-testid="md-chart-close" aria-label="Close full screen" title="Close (Esc)" className={`${ICON_BUTTON} ml-2`} onClick={onClose}>
						<XIcon className="size-4" />
					</button>
				</div>
			</div>
			<div ref={holder} className="min-h-0 w-full flex-1" />
			<div className="mt-1 text-center text-[11px] text-muted-foreground/70">
				Scroll to zoom · drag to pan · drag an axis to stretch it · double-click an axis to reset · + − 0 ← → · Esc closes
			</div>
		</div>,
		document.body,
	);
}
