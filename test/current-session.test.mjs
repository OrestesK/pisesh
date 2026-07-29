import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
const binPath = path.join(packageRoot, "bin", "pisesh");

function loadResumeSession(options = {}) {
	const source = fs.readFileSync(binPath, "utf8").replace(/\nmain\(\);\s*$/, "\nglobalThis.__resumeSession = resumeSession;");
	const spawns = [];
	const env = { ...process.env, PISESH_CURRENT_SESSION: "session-current" };
	if (options.currentCwd === null) {
		delete env.PISESH_CWD;
	} else {
		env.PISESH_CWD = options.currentCwd ?? "/tmp";
	}
	const context = {
		console,
		Buffer,
		setTimeout,
		clearTimeout,
		__dirname: path.dirname(binPath),
		__filename: binPath,
		require(name) {
			if (name === "child_process") {
				return {
					spawn(...args) {
						spawns.push(args);
						return { on() {} };
					},
				};
			}
			return require(name);
		},
		process: {
			env,
			argv: ["node", binPath],
			stdout: { write() {} },
			stdin: { isTTY: true, setRawMode() {}, pause() {} },
			exit(code = 0) { throw { code }; },
			cwd: () => {
				if (options.throwCwd) throw new Error("missing cwd");
				return options.processCwd ?? "/tmp";
			},
		},
	};
	vm.runInNewContext(source, context, { filename: binPath });
	return { resumeSession: context.__resumeSession, spawns };
}

function loadSeshExtension(spawnImpl = () => ({ on() {} })) {
	const source = fs.readFileSync(path.join(packageRoot, "extensions", "sesh.ts"), "utf8")
		.replace('import { spawn } from "node:child_process";', "const { spawn } = globalThis.__childProcess;")
		.replace('import { dirname, resolve } from "node:path";', "const { dirname, resolve } = require('node:path');")
		.replace('import { fileURLToPath } from "node:url";', "const { fileURLToPath } = require('node:url');")
		.replace(/^type .*;\n/gm, "")
		.replace(/function runPisesh\(\s*currentSessionId: string \| undefined,\s*cwd: string,\s*\): Promise<number \| null> \{/, "function runPisesh(currentSessionId, cwd) {")
		.replace("export default function (pi: ExtensionAPI) {", "globalThis.__registerSesh = function (pi) {")
		.replace("let currentId: string | undefined;", "let currentId;")
		.replace("ctx.ui.custom<number | null>(", "ctx.ui.custom(")
		.replace(/import\.meta\.url/g, JSON.stringify(`file://${path.join(packageRoot, "extensions", "sesh.ts")}`));
	const context = {
		__childProcess: { spawn: spawnImpl },
		console,
		require,
		process: {
			...process,
			env: { ...process.env },
			stdout: { write() {} },
		},
	};
	vm.runInNewContext(source, context, { filename: path.join(packageRoot, "extensions", "sesh.ts") });
	return context.__registerSesh;
}

test("resuming the current session exits without spawning pi", () => {
	const { resumeSession, spawns } = loadResumeSession();
	assert.throws(
		() => resumeSession({ id: "session-current", file: "/tmp/current.jsonl", cwd: "/tmp" }),
		(error) => error?.code === 0,
	);
	assert.equal(spawns.length, 0);
});

test("resuming a different session still spawns pi with the session file", () => {
	const { resumeSession, spawns } = loadResumeSession();
	resumeSession({ id: "session-other", file: "/tmp/other.jsonl", cwd: "/tmp" });
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][0], "pi");
	assert.deepEqual(Array.from(spawns[0][1]), ["--session", "/tmp/other.jsonl", "--session-dir", "/tmp"]);
});

test("missing recorded cwd falls back to forwarded pisesh cwd", () => {
	const { resumeSession, spawns } = loadResumeSession();
	resumeSession({ id: "session-other", file: "/tmp/other.jsonl", cwd: "/missing-dir" });
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][2].cwd, "/tmp");
});

test("recorded file path falls back to forwarded pisesh cwd", () => {
	const { resumeSession, spawns } = loadResumeSession();
	resumeSession({ id: "session-other", file: "/tmp/other.jsonl", cwd: binPath });
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][2].cwd, "/tmp");
});

test("invalid forwarded pisesh cwd falls back to process cwd", () => {
	const { resumeSession, spawns } = loadResumeSession({ currentCwd: "/missing-forwarded-cwd", processCwd: "/tmp" });
	resumeSession({ id: "session-other", file: "/tmp/other.jsonl", cwd: "/missing-dir" });
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][2].cwd, "/tmp");
});

test("missing process cwd falls back to session directory root", () => {
	const { resumeSession, spawns } = loadResumeSession({ currentCwd: null, throwCwd: true });
	resumeSession({ id: "session-other", file: "/tmp/other.jsonl", cwd: "/missing-dir" });
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][2].cwd, "/tmp");
});

test("slash command fails closed when current session id is unavailable", async () => {
	let customCalled = false;
	let command;
	const notifications = [];
	const register = loadSeshExtension();
	register({ registerCommand(_name, spec) { command = spec; } });

	await command.handler([], {
		hasUI: true,
		cwd: "/project",
		sessionManager: { getSessionId() { throw new Error("missing id"); } },
		ui: {
			notify(message, level) { notifications.push({ message, level }); },
			custom() { customCalled = true; },
		},
	});

	assert.equal(customCalled, false);
	assert.deepEqual(notifications, [{ message: "/sesh could not identify the current session; session picker was not opened", level: "error" }]);
});

test("slash command forwards session cwd and current session id to vendored pisesh", async () => {
	let command;
	const spawns = [];
	const register = loadSeshExtension((...args) => {
		spawns.push(args);
		return { on(event, callback) { if (event === "exit") callback(0); } };
	});
	register({ registerCommand(_name, spec) { command = spec; } });

	const code = await command.handler([], {
		hasUI: true,
		cwd: "/project",
		sessionManager: { getSessionId() { return "session-current"; } },
		ui: {
			notify() {},
			custom(render) {
				return new Promise((resolveDone) => {
					render({ stop() {}, start() {}, requestRender() {} }, null, null, resolveDone);
				});
			},
		},
	});

	assert.equal(code, undefined);
	assert.equal(spawns.length, 1);
	assert.equal(spawns[0][0], process.execPath);
	assert.equal(spawns[0][1][0], path.join(packageRoot, "bin", "pisesh"));
	assert.equal(spawns[0][2].env.PISESH_CWD, "/project");
	assert.equal(spawns[0][2].env.PISESH_CURRENT_SESSION, "session-current");
});
