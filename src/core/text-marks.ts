/**
 * Inline color marks (owner, 2026-11-04 — "subtle but effective"):
 *   ==phrase==   faint yellow — important / the key term
 *   ==+phrase==  faint green  — good, correct, what to do
 *   ==-phrase==  faint red    — bad, wrong, a risk
 * One pattern shared by the renderer (components/md-marks.ts, a remark
 * plugin over TEXT nodes only — code and math never match) and read-aloud
 * (the markers are stripped, the words spoken). PURE, browser-safe.
 */

export type MarkTone = "key" | "good" | "bad";

/** `==` + optional tone sign + content that starts and ends non-blank,
 *  on one line, + `==`. A fresh RegExp per call site (it is global). */
export const markPattern = () => /==([+-]?)(\S(?:[^\n]*?\S)?)==/g;

export function markTone(sign: string): MarkTone {
	return sign === "+" ? "good" : sign === "-" ? "bad" : "key";
}

/** Plain text with the mark syntax removed (speech, previews). */
export function stripMarks(text: string): string {
	return text.replace(markPattern(), "$2");
}
