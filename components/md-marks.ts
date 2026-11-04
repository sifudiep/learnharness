/**
 * The remark plugin for inline color marks (==…==, ==+…==, ==-…==; the
 * grammar is src/core/text-marks.ts). It rewrites TEXT nodes only, so
 * inline code, code blocks and math never match, and emits a <mark
 * class="lh-mark" data-tone> element — tinted faintly in globals.css.
 */

import { markPattern, markTone } from "@/src/core";

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

function split(text: Node): Node[] {
	const value = text.value ?? "";
	const out: Node[] = [];
	let last = 0;
	for (const m of value.matchAll(markPattern())) {
		if (m.index! > last) out.push({ type: "text", value: value.slice(last, m.index) });
		out.push({
			type: "lhMark",
			children: [{ type: "text", value: m[2]! }],
			data: { hName: "mark", hProperties: { className: ["lh-mark"], "data-tone": markTone(m[1]!) } },
		});
		last = m.index! + m[0].length;
	}
	if (last === 0) return [text];
	if (last < value.length) out.push({ type: "text", value: value.slice(last) });
	return out;
}

function walk(node: Node): void {
	if (!node.children) return;
	const next: Node[] = [];
	for (const child of node.children) {
		if (child.type === "text" && child.value?.includes("==")) next.push(...split(child));
		else {
			walk(child);
			next.push(child);
		}
	}
	node.children = next;
}

export default function remarkMarks() {
	return (tree: Node) => walk(tree);
}
