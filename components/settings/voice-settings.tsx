"use client";
/**
 * The Voice group (voice wave, owner 2026-10-28): the read-aloud voice
 * picker — every Aura-2 English voice as "Name · accent · style tags" —
 * plus a Preview that speaks the owner's sample line, and the speed
 * (0.7–1.5×, the same setting as the chat's speed pill). Stored on this
 * device (src/core/voice.ts prefs), like the keymap.
 */

import { useEffect, useState } from "react";
import { AURA2_VOICES, DEFAULT_SPEED, DEFAULT_VOICE, formatSpeed, loadVoicePrefs, previewLine, saveVoicePrefs, VOICE_PREFS_EVENT, VOICE_SPEEDS } from "@/src/core";
import { DeepgramKeylessError, warmTokens } from "@/components/deepgram-token";
import { endTurn, setVoiceSpeed, speak, stopVoice, unlockAudio, VOICE_KEYLESS } from "@/components/voice";
import { SettingsGroup, SettingsRow, ThinSelect } from "./controls.tsx";

export function VoiceSettings() {
	const [voice, setVoice] = useState(DEFAULT_VOICE);
	const [speed, setSpeed] = useState(DEFAULT_SPEED);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		// The chat's speed pill writes the same prefs — follow it live.
		const sync = () => {
			const p = loadVoicePrefs();
			setVoice(p.voice);
			setSpeed(p.speed);
		};
		sync();
		window.addEventListener(VOICE_PREFS_EVENT, sync);
		return () => window.removeEventListener(VOICE_PREFS_EVENT, sync);
	}, []);

	const preview = () => {
		setError(null);
		unlockAudio(); // under the click gesture
		stopVoice();
		warmTokens.mint().then(
			() => {
				speak(previewLine(voice));
				endTurn();
			},
			(e: unknown) => setError(e instanceof DeepgramKeylessError ? VOICE_KEYLESS : e instanceof Error ? e.message : "token unavailable"),
		);
	};

	return (
		<SettingsGroup label="Voice" testid="group-voice">
			<SettingsRow label="Read-aloud voice" hint={error ?? "Stored on this device"}>
				<div className="flex items-center gap-1.5">
					<ThinSelect
						value={voice}
						ariaLabel="Read-aloud voice"
						testid="voice-select"
						onChange={(v) => {
							setVoice(v);
							saveVoicePrefs({ voice: v });
						}}
					>
						{AURA2_VOICES.map((v) => (
							<option key={v.id} value={v.id}>
								{`${v.name} · ${v.accent} · ${v.tags.join(", ")}`}
							</option>
						))}
					</ThinSelect>
					<button
						type="button"
						onClick={preview}
						data-testid="voice-preview"
						className="h-7 shrink-0 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent"
					>
						Preview
					</button>
				</div>
			</SettingsRow>
			<SettingsRow label="Speed">
				<ThinSelect
					value={String(speed)}
					ariaLabel="Read-aloud speed"
					testid="voice-speed-select"
					onChange={(v) => setVoiceSpeed(Number(v))}
				>
					{VOICE_SPEEDS.map((sp) => (
						<option key={sp} value={String(sp)}>
							{formatSpeed(sp)}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>
		</SettingsGroup>
	);
}
