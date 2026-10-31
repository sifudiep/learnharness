// speech-rule-engine has no "types"/"exports" entries, so TypeScript can't
// resolve its .d.ts. Only the API math-speech.ts uses is declared.
declare module "speech-rule-engine/js/common/system.js" {
	export function setupEngine(feature: {
		locale?: string;
		domain?: string;
		modality?: string;
		custom?: (locale: string) => Promise<string>;
	}): Promise<void>;
	export function engineReady(): Promise<unknown>;
	export function toSpeech(expr: string): string;
}
