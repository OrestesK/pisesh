/**
 * pisesh slash command
 *
 * `/sesh` temporarily hands the terminal to the bundled picker. The picker
 * returns a session path on a private fd; this extension then asks the host to
 * switch its current runtime. Standalone `pisesh` launches the selected host.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildHandoffPayload,
	parseHandoffHookDescriptor,
	parseSeshHandoffHookArgs,
	runHandoffHook,
} from "../lib/handoff-hook.js";
import type { HandoffHookDescriptor } from "../lib/handoff-hook.js";
import { normalizeSwitchResult } from "../lib/switch-result.js";

// Static package path, no user-controlled segments.
const PISESH_CLI = path.resolve(__dirname, "../bin/pisesh"); // pi-lens-ignore: ts-path-traversal
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type PiseshSelection = {
	version: 1;
	sessionPath: string;
	cwdOverride?: string;
	model?: string;
	thinking?: ThinkingLevel;
	repaired?: number;
	handoffHook?: HandoffHookDescriptor;
};

type PickerResult = {
	code: number | null;
	selection?: PiseshSelection;
	error?: string;
};

type PendingSwitch = Pick<
	PiseshSelection,
	"sessionPath" | "cwdOverride" | "model" | "thinking" | "repaired"
> & {
	backend: "pi" | "omp";
	handoffWarning?: string;
};

const processState = globalThis as typeof globalThis & {
	__piseshPendingSwitch?: PendingSwitch;
	__piseshPendingHandoff?: HandoffHookDescriptor;
};

function parseSelection(raw: string): PiseshSelection | undefined {
	if (!raw.trim()) return undefined;

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("picker returned invalid JSON");
	}
	if (!value || typeof value !== "object") {
		throw new Error("picker returned a non-object selection");
	}
	const data = value as Record<string, unknown>;
	if (
		data.version !== 1 ||
		typeof data.sessionPath !== "string" ||
		path.isAbsolute(data.sessionPath) === false
	) {
		throw new Error("picker returned an invalid session selection");
	}
	if (data.cwdOverride !== undefined && typeof data.cwdOverride !== "string") {
		throw new Error("picker returned an invalid cwd override");
	}
	if (data.model !== undefined && typeof data.model !== "string") {
		throw new Error("picker returned an invalid model");
	}
	if (
		data.thinking !== undefined &&
		!THINKING_LEVELS.includes(data.thinking as ThinkingLevel)
	) {
		throw new Error("picker returned an invalid thinking level");
	}
	if (
		data.repaired !== undefined &&
		(!Number.isInteger(data.repaired) || (data.repaired as number) < 0)
	) {
		throw new Error("picker returned an invalid repair count");
	}
	const handoffHook = parseHandoffHookDescriptor(data.handoffHook);
	return { ...data, ...(handoffHook ? { handoffHook } : {}) } as PiseshSelection;
}

function runPisesh(
	currentSessionId: string | undefined,
	backend: "pi" | "omp",
	currentCwd: string,
	hookExecutable?: string,
): Promise<PickerResult> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		const finish = (result: PickerResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		// fd 3 carries one small JSON result while stdin/stdout/stderr remain the
		// real terminal used by the full-screen picker.
		const child = spawn("node", [
			PISESH_CLI,
			`--backend=${backend}`,
			...(hookExecutable ? [`--handoff-hook=${hookExecutable}`] : []),
		], {
			stdio: ["inherit", "inherit", "inherit", "pipe"],
			env: {
				...process.env,
				PISESH_SELECT_FD: "3",
				PISESH_BACKEND: backend,
				PISESH_CWD: currentCwd,
				...(currentSessionId
					? { PISESH_CURRENT_SESSION: currentSessionId }
					: {}),
			},
		});
		const resultPipe = child.stdio[3] as Readable | null;
		resultPipe?.setEncoding("utf8");
		resultPipe?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("close", (code) => {
			if (code !== 0) return finish({ code });
			try {
				finish({ code, selection: parseSelection(output) });
			} catch (error) {
				finish({
					code,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		child.on("error", (error) => {
			process.stdout.write(
				`\x1b[31mpisesh failed to launch: ${error.message}\x1b[0m\n`,
			);
			finish({ code: 127, error: error.message });
		});
	});
}

function sameSession(left: string | undefined, right: string): boolean {
	return left ? path.resolve(left) === path.resolve(right) : false;
}

export default function (pi: ExtensionAPI) {
	// A successful switch loads a fresh extension instance before the old command
	// returns. Plain pending data on globalThis lets that new instance apply the
	// selected model and thinking without touching stale pre-switch pi/ctx objects.
	pi.on("session_shutdown", async (event, _ctx) => {
		const pending = processState.__piseshPendingSwitch;
		const handoff = processState.__piseshPendingHandoff;
		if (
			!pending ||
			!handoff ||
			event.reason !== "resume" ||
			!sameSession(event.targetSessionFile, pending.sessionPath) ||
			!sameSession(handoff.session.path, pending.sessionPath)
		) {
			return;
		}
		processState.__piseshPendingHandoff = undefined;
		const result = await runHandoffHook(
			handoff.executable,
			buildHandoffPayload(handoff.session, "sesh"),
		);
		if (!result.ok) pending.handoffWarning = result.warning;
	});

	pi.on("session_start", async (event, ctx) => {
		const pending = processState.__piseshPendingSwitch;
		if (
			event.reason !== "resume" ||
			!pending ||
			!sameSession(ctx.sessionManager.getSessionFile(), pending.sessionPath)
		) {
			return;
		}
		processState.__piseshPendingSwitch = undefined;
		if (pending.handoffWarning) {
			ctx.ui.notify(`pisesh: ${pending.handoffWarning}`, "warning");
		}

		if (pending.model) {
			const separator = pending.model.indexOf("/");
			const model =
				separator > 0
					? ctx.modelRegistry.find(
							pending.model.slice(0, separator),
							pending.model.slice(separator + 1),
						)
					: undefined;
			if (!model || !(await pi.setModel(model))) {
				ctx.ui.notify(
					`Could not apply resume model: ${pending.model}`,
					"warning",
				);
			}
		}
		if (pending.thinking) {
			pi.setThinkingLevel(
				pending.thinking as Parameters<typeof pi.setThinkingLevel>[0],
			);
		}
		if (pending.repaired) {
			ctx.ui.notify(
				`Repaired ${pending.repaired} interrupted tool call${pending.repaired === 1 ? "" : "s"} before resume`,
				"warning",
			);
		}
		if (
			pending.cwdOverride &&
			path.resolve(ctx.cwd) !== path.resolve(pending.cwdOverride)
		) {
			ctx.ui.notify(
				`This ${pending.backend === "omp" ? "OMP" : "Pi"} version did not apply the selected cwd override`,
				"warning",
			);
		}
	});

	pi.registerCommand("sesh", {
		description: "Browse, star, and resume Pi or OMP sessions (opens pisesh TUI)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sesh requires an interactive TUI", "warning");
				return;
			}
			let hookExecutable: string | undefined;
			try {
				hookExecutable = parseSeshHandoffHookArgs(args);
			} catch (error) {
				ctx.ui.notify(
					`pisesh: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const currentId = ctx.sessionManager.getSessionId();
			const backend = "models" in ctx ? "omp" : "pi";
			const result = await ctx.ui.custom<PickerResult>(
				(tui, _theme, _keybindings, done) => {
					tui.stop();
					process.stdout.write("\x1b[2J\x1b[H");
					void runPisesh(currentId, backend, ctx.cwd, hookExecutable).then((pickerResult) => {
						tui.start();
						tui.requestRender(true);
						done(pickerResult);
					});
					return { render: () => [], invalidate: () => {} };
				},
			);

			if (!result) return;
			if (result.error) {
				ctx.ui.notify(`pisesh: ${result.error}`, "error");
				return;
			}
			if (result.code !== 0 && result.code !== null) {
				ctx.ui.notify(`pisesh exited with code ${result.code}`, "warning");
				return;
			}
			const selection = result.selection;
			if (!selection) return;

			const currentFile = ctx.sessionManager.getSessionFile();
			if (sameSession(currentFile, selection.sessionPath)) {
				ctx.ui.notify("That session is already active", "info");
				return;
			}

			const pending: PendingSwitch = {
				sessionPath: selection.sessionPath,
				backend,
				cwdOverride: selection.cwdOverride,
				model: selection.model,
				thinking: selection.thinking,
				repaired: selection.repaired,
			};
			processState.__piseshPendingSwitch = pending;
			processState.__piseshPendingHandoff = selection.handoffHook;

			try {
				const switchSession = ctx.switchSession as (
					sessionPath: string,
					options?: { cwdOverride?: string },
				) => Promise<unknown>;
				const switched = pending.backend === "omp"
					? await switchSession(selection.sessionPath)
					: await switchSession(
							selection.sessionPath,
							selection.cwdOverride
								? { cwdOverride: selection.cwdOverride }
								: undefined,
						);
				if (normalizeSwitchResult(switched).cancelled) {
					processState.__piseshPendingSwitch = undefined;
					processState.__piseshPendingHandoff = undefined;
					ctx.ui.notify("Resume cancelled", "info");
				}
			} catch (error) {
				if (pending.handoffWarning) {
					process.stderr.write(`pisesh: ${pending.handoffWarning}\n`);
				}
				processState.__piseshPendingSwitch = undefined;
				processState.__piseshPendingHandoff = undefined;
				throw error;
			} finally {
				if (processState.__piseshPendingSwitch === pending) {
					processState.__piseshPendingSwitch = undefined;
				}
				if (processState.__piseshPendingHandoff === selection.handoffHook) {
					processState.__piseshPendingHandoff = undefined;
				}
			}
		},
	});
}
