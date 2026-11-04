"use client";

/**
 * The chat calculator (owner, 2026-11-02): a basic calculator with %,
 * ± and parentheses plus a history tape, in a panel on the right of the
 * session — chat and calculator share the area as a centered pair.
 *
 * - Toggle: the top-bar button or ⌥C (registry "toggle-calculator"). Open
 *   lands focus IN the calculator; open/closed and the tape persist on
 *   this device (localStorage `lh:calc`).
 * - Keys act ONLY while the calculator is focused (its onKeyDown): digits,
 *   . + - * / x ( ) %, Enter or = evaluates, Backspace deletes, C clears,
 *   ↑ recalls the last expression, Esc closes. Keys it uses never reach
 *   the app's global shortcuts; everything else (⌥C, ⌥D…) passes through.
 * - The arithmetic is src/core/calc.ts (a parser, never eval).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DeleteIcon, XIcon } from "lucide-react";
import { evaluateCalc, formatCalc, kbdEventForAction, previewCalc } from "@/src/core";
import { cn } from "@/lib/utils";

type Entry = { expr: string; result: string };
type Stored = { open: boolean; tape: Entry[] };

const KEY = "lh:calc";
const TAPE_MAX = 50;

function load(): Stored {
	try {
		const raw = window.localStorage.getItem(KEY);
		const s = raw ? (JSON.parse(raw) as Partial<Stored>) : {};
		return {
			open: s.open === true,
			tape: Array.isArray(s.tape) ? s.tape.filter((e) => typeof e?.expr === "string" && typeof e?.result === "string").slice(-TAPE_MAX) : [],
		};
	} catch {
		return { open: false, tape: [] };
	}
}

function save(s: Stored): void {
	try {
		window.localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* storage unavailable: the calculator still works this visit */
	}
}

/** Open/closed + tape, persisted; ⌥C toggles. One instance per chat page. */
export function useCalculator() {
	const [state, setState] = useState<Stored>({ open: false, tape: [] });
	useEffect(() => setState(load()), []); // after mount: hydration stays clean
	const update = useCallback((patch: Partial<Stored>) => {
		setState((prev) => {
			const next = { ...prev, ...patch };
			save(next);
			return next;
		});
	}, []);
	/** Bumped when the learner OPENS it (button / ⌥C) — the panel focuses
	 *  itself then; a reload restoring it open leaves focus alone. */
	const [focusTick, setFocusTick] = useState(0);
	const toggle = useCallback(() => {
		setState((prev) => {
			const next = { ...prev, open: !prev.open };
			save(next);
			if (next.open) setFocusTick((t) => t + 1);
			return next;
		});
	}, []);
	useEffect(() => {
		const ev = kbdEventForAction("toggle-calculator");
		window.addEventListener(ev, toggle);
		return () => window.removeEventListener(ev, toggle);
	}, [toggle]);
	// Stable, and a no-op when already closed: the chat's panel swap calls
	// it from an effect (a fresh function / fresh state each time looped).
	const close = useCallback(
		() =>
			setState((prev) => {
				if (!prev.open) return prev;
				const next = { ...prev, open: false };
				save(next);
				return next;
			}),
		[],
	);
	const setTape = useCallback((tape: Entry[]) => update({ tape }), [update]);
	return { open: state.open, tape: state.tape, focusTick, toggle, close, setTape };
}

export type Calculator = ReturnType<typeof useCalculator>;

const KEYS = [
	["C", "(", ")", "÷"],
	["7", "8", "9", "×"],
	["4", "5", "6", "−"],
	["1", "2", "3", "+"],
	["±", "0", ".", "%"],
] as const;

const OPS = new Set(["+", "−", "×", "÷"]);

export function CalculatorPanel({ calc }: { calc: Calculator }) {
	const [expr, setExpr] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [recall, setRecall] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const tapeRef = useRef<HTMLDivElement>(null);

	// Opening lands focus in the calculator (owner: focused at start).
	useEffect(() => {
		if (calc.focusTick > 0) rootRef.current?.focus({ preventScroll: true });
	}, [calc.focusTick]);
	useEffect(() => {
		tapeRef.current?.scrollTo({ top: tapeRef.current.scrollHeight });
	}, [calc.tape.length]);

	const lastResult = calc.tape.at(-1)?.result;

	const input = (k: string) => {
		setError(null);
		setRecall(null);
		setExpr((cur) => {
			// Starting with an operator continues from the last answer (pocket-calculator "Ans").
			if (!cur && OPS.has(k) && k !== "−" && lastResult) return `${lastResult.replace(/,/g, "")} ${k} `;
			if (OPS.has(k)) return `${cur.trimEnd()} ${k} `;
			return cur + k;
		});
	};
	const clear = () => {
		setExpr("");
		setError(null);
		setRecall(null);
	};
	const backspace = () => {
		setError(null);
		setExpr((cur) => cur.trimEnd().slice(0, -1).replace(/\s+$/, (m) => (m ? " " : "")));
	};
	const negate = () => {
		// ± flips the sign of the trailing number (or the whole when there is none).
		setExpr((cur) => {
			const m = /(-?)(\d[\d.,]*)$/.exec(cur);
			if (!m) return cur ? `-(${cur})` : cur;
			const start = m.index;
			return cur.slice(0, start) + (m[1] ? m[2] : `-${m[2]}`);
		});
	};
	const evaluate = () => {
		if (!expr.trim()) return;
		const r = evaluateCalc(expr);
		if (!r.ok) {
			setError(r.error);
			return;
		}
		const result = formatCalc(r.value);
		calc.setTape([...calc.tape, { expr: expr.trim(), result }].slice(-TAPE_MAX));
		setExpr("");
		setError(null);
		setRecall(null);
	};
	const press = (k: string) => {
		if (k === "C") clear();
		else if (k === "±") negate();
		else input(k);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌥C, ⌘… stay the app's
		let used = true;
		const k = e.key;
		if (/^[0-9.]$/.test(k) || k === "(" || k === ")" || k === "%") input(k);
		else if (k === "+") input("+");
		else if (k === "-") input("−");
		else if (k === "*" || k === "x" || k === "X") input("×");
		else if (k === "/") input("÷");
		else if (k === "Enter" || k === "=") evaluate();
		else if (k === "Backspace") backspace();
		else if (k === "c" || k === "C" || k === "Delete") clear();
		else if (k === "ArrowUp" && calc.tape.length) {
			const i = recall === null ? calc.tape.length - 1 : Math.max(0, recall - 1);
			setRecall(i);
			setExpr(calc.tape[i]!.expr);
		} else if (k === "Escape") calc.close();
		else used = false;
		if (used) {
			e.preventDefault();
			e.stopPropagation(); // the app's shortcuts (P, arrows, Esc chain) stay out
		}
	};

	const preview = expr ? previewCalc(expr) : null;

	return (
		<aside
			data-testid="calculator"
			aria-label="Calculator"
			className="flex h-full w-[19rem] shrink-0 flex-col justify-center border-l border-border/60 px-4 py-6"
		>
			<div
				ref={rootRef}
				tabIndex={0}
				onKeyDown={onKeyDown}
				className="flex max-h-full flex-col rounded-2xl border bg-card p-3 shadow-lg outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
			>
				<div className="mb-2 flex items-center justify-between">
					<span className="text-xs uppercase tracking-widest text-muted-foreground">Calculator</span>
					<button
						type="button"
						onClick={calc.close}
						aria-label="Close calculator"
						className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
				{/* The tape: past calculations; click one to reuse its result. */}
				<div ref={tapeRef} data-testid="calculator-tape" className="mb-2 max-h-48 min-h-10 overflow-y-auto font-mono text-xs">
					{calc.tape.length === 0 ? (
						<div className="py-2 text-center text-muted-foreground/60">No calculations yet</div>
					) : (
						calc.tape.map((t, i) => (
							<button
								key={i}
								type="button"
								onClick={() => {
									setExpr((cur) => cur + t.result.replace(/,/g, ""));
									rootRef.current?.focus();
								}}
								className="flex w-full justify-between gap-2 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								title="Use this result"
							>
								<span className="truncate">{t.expr}</span>
								<span className="shrink-0 text-foreground">= {t.result}</span>
							</button>
						))
					)}
				</div>
				<div className="mb-3 rounded-lg bg-background/60 px-3 py-2 text-right font-mono">
					<div data-testid="calculator-expr" className="min-h-6 break-all text-lg text-foreground">{expr || "0"}</div>
					<div className={cn("min-h-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
						{error ?? (preview !== null ? `= ${preview}` : "")}
					</div>
				</div>
				<div className="grid grid-cols-4 gap-1.5">
					{KEYS.flat().map((k) => (
						<button
							key={k}
							type="button"
							tabIndex={-1}
							onMouseDown={(e) => e.preventDefault()} // keep focus on the calculator
							onClick={() => press(k)}
							className={cn(
								"h-10 rounded-lg font-mono text-sm transition-colors",
								OPS.has(k) ? "bg-accent text-foreground hover:bg-accent/70" : "bg-background/60 text-foreground hover:bg-accent",
								k === "C" && "text-destructive",
							)}
						>
							{k}
						</button>
					))}
					<button
						type="button"
						tabIndex={-1}
						onMouseDown={(e) => e.preventDefault()}
						onClick={backspace}
						aria-label="Backspace"
						className="col-span-1 flex h-10 items-center justify-center rounded-lg bg-background/60 text-muted-foreground transition-colors hover:bg-accent"
					>
						<DeleteIcon className="size-4" />
					</button>
					<button
						type="button"
						tabIndex={-1}
						onMouseDown={(e) => e.preventDefault()}
						onClick={evaluate}
						className="col-span-3 h-10 rounded-lg bg-primary font-mono text-sm text-primary-foreground transition-opacity hover:opacity-90"
					>
						=
					</button>
				</div>
				<div className="mt-2 text-center text-[10px] text-muted-foreground/70">
					Type to calculate · ↵ = · ⌫ · C clears · ↑ recalls · Esc closes
				</div>
			</div>
		</aside>
	);
}
