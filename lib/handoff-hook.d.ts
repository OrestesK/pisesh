export type HandoffSource = "cli" | "sesh";

export interface HandoffSession {
	id: string;
	path: string;
	title: string;
	cwd: string;
}

export interface HandoffHookDescriptor {
	executable: string;
	session: HandoffSession;
}

export interface HandoffPayload {
	version: 1;
	event: "handoff";
	source: HandoffSource;
	session: HandoffSession;
}

export type HandoffHookResult =
	| { ok: true }
	| { ok: false; warning: string };

export interface HandoffHookResolution {
	executable?: string;
	warning?: string;
}

export function resolveHandoffHook(
	argv?: readonly string[],
	env?: Readonly<Record<string, string | undefined>>,
): HandoffHookResolution;

export function parseSeshHandoffHookArgs(raw: string): string | undefined;

export function parseHandoffHookDescriptor(
	value: unknown,
): HandoffHookDescriptor | undefined;

export function createHandoffHookDescriptor(
	executable: string,
	session: HandoffSession,
): HandoffHookDescriptor;

export function buildHandoffPayload(
	session: HandoffSession,
	source: HandoffSource,
): HandoffPayload;

export function runHandoffHook(
	executable: string,
	payload: HandoffPayload,
	env?: Readonly<Record<string, string | undefined>>,
): Promise<HandoffHookResult>;
