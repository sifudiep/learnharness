// speech-rule-engine ships its .d.ts under js/ without a "types" entry, so
// TypeScript can't find it. Only the API math-speech.ts uses is declared.
declare module "speech-rule-engine" {
	export function setupEngine(feature: {
		locale?: string;
		domain?: string;
		modality?: string;
		custom?: (locale: string) => Promise<string>;
	}): Promise<void>;
	export function engineReady(): Promise<unknown>;
	export function toSpeech(expr: string): string;
}
