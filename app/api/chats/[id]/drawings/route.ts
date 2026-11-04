/** The learner's chart drawings for one chart of this chat — saved with the
 *  chat, shown to the teacher on the next turn (src/server/chats.ts). */
import { putChartDrawings } from "@/src/server";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	return putChartDrawings(id, body);
}
