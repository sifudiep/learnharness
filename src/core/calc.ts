/**
 * The chat calculator's arithmetic (calculator wave, owner 2026-11-02) —
 * PURE, browser-safe, and never `eval`: a small recursive-descent parser
 * over + − × ÷, parentheses, unary minus and %.
 *
 * Percent follows the pocket-calculator convention swing traders expect:
 *   200 + 10%  = 220      (± a percent OF the left side)
 *   200 × 10%  = 20       (× ÷ a plain hundredth)
 *   10%        = 0.1
 */

export type CalcResult = { ok: true; value: number } | { ok: false; error: string };

type Tok = { kind: "num"; value: number } | { kind: "op"; op: string };

class CalcError extends Error {}

const OP_ALIASES: Record<string, string> = { "×": "*", x: "*", X: "*", "÷": "/", "−": "-", "–": "-" };

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (/\s|,/.test(ch)) {
			i++; // spaces and thousands separators are layout, not math
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			let j = i;
			while (j < src.length && /[0-9.,]/.test(src[j]!)) j++;
			const raw = src.slice(i, j).replace(/,/g, "");
			if ((raw.match(/\./g)?.length ?? 0) > 1 || raw === ".") throw new CalcError(`"${raw}" is not a number`);
			out.push({ kind: "num", value: Number(raw) });
			i = j;
			continue;
		}
		const op = OP_ALIASES[ch] ?? ch;
		if ("+-*/()%".includes(op)) {
			out.push({ kind: "op", op });
			i++;
			continue;
		}
		throw new CalcError(`Unexpected "${ch}"`);
	}
	return out;
}

/** Evaluate a calculator expression. */
export function evaluateCalc(src: string): CalcResult {
	try {
		const toks = tokenize(src);
		if (!toks.length) throw new CalcError("Nothing to calculate");
		let pos = 0;
		const peek = () => toks[pos];
		const isOp = (op: string) => {
			const t = toks[pos];
			return t?.kind === "op" && t.op === op;
		};

		// A factor carries whether it ended in % (the ± percent-of rule).
		type Val = { value: number; percent: boolean };

		const primary = (): Val => {
			const t = peek();
			if (!t) throw new CalcError("Incomplete expression");
			if (t.kind === "num") {
				pos++;
				return { value: t.value, percent: false };
			}
			if (t.op === "(") {
				pos++;
				const v = expr();
				if (!isOp(")")) throw new CalcError("Missing )");
				pos++;
				return { value: v, percent: false };
			}
			throw new CalcError(t.op === ")" ? "Unexpected )" : "Incomplete expression");
		};
		const unary = (): Val => {
			if (isOp("-")) {
				pos++;
				const v = unary();
				return { value: -v.value, percent: v.percent };
			}
			if (isOp("+")) {
				pos++;
				return unary();
			}
			return primary();
		};
		const factor = (): Val => {
			const v = unary();
			if (isOp("%")) {
				pos++;
				return { value: v.value, percent: true };
			}
			return v;
		};
		const plain = (v: Val) => (v.percent ? v.value / 100 : v.value);
		const term = (): Val => {
			let left = factor();
			while (isOp("*") || isOp("/")) {
				const op = (peek() as { op: string }).op;
				pos++;
				const right = plain(factor());
				const l = plain(left);
				if (op === "/" && right === 0) throw new CalcError("Can't divide by 0");
				left = { value: op === "*" ? l * right : l / right, percent: false };
			}
			return left;
		};
		const expr = (): number => {
			let left = plain(term());
			while (isOp("+") || isOp("-")) {
				const op = (peek() as { op: string }).op;
				pos++;
				const r = term();
				const right = r.percent ? (left * r.value) / 100 : r.value; // 200 + 10% = 220
				left = op === "+" ? left + right : left - right;
			}
			return left;
		};

		const value = expr();
		if (pos < toks.length) throw new CalcError(isOp(")") ? "Unexpected )" : "Incomplete expression");
		if (!Number.isFinite(value)) throw new CalcError("Result is too large");
		// Float noise (0.1 + 0.2): round to 12 significant digits.
		return { ok: true, value: Number(value.toPrecision(12)) };
	} catch (e) {
		if (e instanceof CalcError) return { ok: false, error: e.message };
		throw e;
	}
}

/** The display form: grouped thousands, rounded to 2 decimals — prices
 *  and share counts (owner, 2026-11-03); no float tail. */
export function formatCalc(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The live preview while typing: the expression without a dangling
 *  operator or open paren, when that evaluates — else nothing. */
export function previewCalc(src: string): string | null {
	let s = src.trim().replace(/[+\-*/×÷−(]+$/, "");
	const open = (s.match(/\(/g)?.length ?? 0) - (s.match(/\)/g)?.length ?? 0);
	if (open > 0) s += ")".repeat(open);
	if (!s) return null;
	const r = evaluateCalc(s);
	return r.ok ? formatCalc(r.value) : null;
}
