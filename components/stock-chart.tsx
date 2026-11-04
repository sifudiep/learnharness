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
 * - The mouse wheel stays the transcript's (no wheel zoom/scroll — it
 *   would hijack page scrolling); drag pans, pinch and axis-drag zoom,
 *   double-click the axis to reset.
 * - Colors follow the app theme tokens and re-apply on a theme flip.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseChartSpec, type ChartBar, type ChartLineStyle, type ChartSpec, type ChartTone } from "@/src/core";

const DAY = 86_400;
const HEIGHT = 320;
/** Candle pitch cap: a short series stays readable candles (not slabs) —
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

function ChartCanvas({ spec, corner, height }: { spec: ChartSpec; corner?: ReactNode; height: number }) {
	const holder = useRef<HTMLDivElement>(null);
	const last = spec.bars[spec.bars.length - 1]!;
	const [hovered, setHovered] = useState<ChartBar>(last);

	useEffect(() => {
		setHovered(spec.bars[spec.bars.length - 1]!);
		const el = holder.current;
		if (!el) return;
		let disposed = false;
		let cleanup = () => {};
		void import("lightweight-charts").then((lc) => {
			if (disposed) return;
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
					fixLeftEdge: true,
					rightOffset: RIGHT_ROOM,
					maxBarSpacing: MAX_BAR_SPACING,
				},
				localization: { timeFormatter: (time: unknown) => labelOf(time), priceFormatter: formatPrice },
				crosshair: { mode: lc.CrosshairMode.Normal },
				handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
				handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
			});
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
			chart.timeScale().fitContent();
			chart.timeScale().applyOptions({ rightOffset: RIGHT_ROOM }); // fitContent zeroes it
			// The OHLC legend follows the crosshair; off the chart it shows the last bar.
			chart.subscribeCrosshairMove((param) => {
				const i = param.time === undefined ? spec.bars.length - 1 : Math.round(Number(param.time) / DAY) - 1;
				const bar = spec.bars[i];
				if (bar) setHovered(bar);
			});
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
				observer.disconnect();
				chart.remove();
			};
		});
		return () => {
			disposed = true;
			cleanup();
		};
	}, [spec]);

	const up = hovered.c >= hovered.o;
	return (
		<div data-testid="md-chart" data-lh-chart="" className="group/md relative my-4">
			<div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pr-8 font-mono text-xs">
				{spec.title && <span className="font-ui text-sm text-foreground">{spec.title}</span>}
				<span className="text-muted-foreground" data-testid="md-chart-legend">
					{hovered.t} <span className="opacity-70">O</span> {formatPrice(hovered.o)} <span className="opacity-70">H</span>{" "}
					{formatPrice(hovered.h)} <span className="opacity-70">L</span> {formatPrice(hovered.l)}{" "}
					<span className="opacity-70">C</span>{" "}
					<span style={{ color: up ? TONE_COLORS.up : TONE_COLORS.down }}>{formatPrice(hovered.c)}</span>
				</span>
			</div>
			<div
				ref={holder}
				className="w-full"
				style={{ height, maxWidth: (spec.bars.length + RIGHT_ROOM) * MAX_BAR_SPACING + PRICE_SCALE_ROOM }}
			/>
			{corner && <div className="absolute top-0 right-0">{corner}</div>}
		</div>
	);
}
