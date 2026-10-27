/**
 * GET /api/claude-code — the dev-only Claude Code CLI connection's status
 * for the read-only Providers row (LH_CLAUDE_CODE_CLI=1; owner,
 * 2026-10-27). Re-runs `claude auth status` on every request so the row
 * reflects a terminal login/logout immediately; with the flag unset it
 * answers {enabled: false} without spawning anything.
 */
import { refreshClaudeCodeStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await refreshClaudeCodeStatus(true), { headers: { "Cache-Control": "no-store" } });
}
