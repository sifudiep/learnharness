/** Quick ask: a side question about this chat, answered by its model and
 *  streamed as SSE — never written to the chat (src/server/quick-ask.ts). */
import { handleQuickAsk } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	return handleQuickAsk(id, body, req.signal);
}
