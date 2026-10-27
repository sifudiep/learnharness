"use client";
/**
 * The dev-only Claude Code CLI connection row (LH_CLAUDE_CODE_CLI=1; owner,
 * 2026-10-27): READ-ONLY — no in-app sign-in. It shows whether the local
 * `claude` is logged in (auth method + plan), or how to log in. Renders
 * nothing when the flag is off. GET /api/claude-code re-runs
 * `claude auth status` per request.
 */

import { useEffect, useState } from "react";
import type { ClaudeCodeStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

export function ClaudeCodeConnection() {
	const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/api/claude-code")
			.then((res) => (res.ok ? (res.json() as Promise<ClaudeCodeStatus>) : null))
			.then((next) => {
				if (!live || !next) return;
				setStatus(next);
				// A terminal login/logout since the picker last loaded: let readers
				// re-fetch the catalog (this fetch just refreshed the server cache).
				if (next.enabled) notifySettingsSaved("keys");
			})
			.catch(() => undefined);
		return () => { live = false; };
	}, []);
	if (!status?.enabled) return null;
	const detail = status.loggedIn
		? [status.authMethod, status.subscriptionType].filter(Boolean).join(" · ")
		: status.error ?? "Run `claude auth login` in a terminal.";
	return <div className="flex flex-wrap items-center gap-3" data-testid="claude-code-connection">
		<span className="font-ui text-xs text-foreground">Claude Code CLI</span>
		<span className={`font-mono text-[11px] ${status.loggedIn ? "text-muted-foreground" : "text-red-400"}`} data-testid="claude-code-status">
			{status.loggedIn ? (detail ? `Logged in · ${detail}` : "Logged in") : detail}
		</span>
		<span className="font-ui text-[11px] text-muted-foreground/70">dev only</span>
	</div>;
}
