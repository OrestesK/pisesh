import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	collectCleanupPlan,
	performCleanupPlan,
	sanitizePart,
} from "../lib/cleanup.js";

function makeTempHome() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pisesh-cleanup-"));
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	return { root, home };
}

function writeFile(file, content = "x") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function makeSession(home, id = "session-1", cwd = path.join(home, "project")) {
	const projectSlug = "--home-orestes-project--";
	const sessionDir = path.join(home, ".pi", "agent", "sessions", projectSlug);
	const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
	return { id, file, cwd, effectiveCwd: path.join(home, "override"), isCurrent: false };
}

test("sanitizePart matches Slipstream artifact name sanitization", () => {
	assert.equal(sanitizePart("abc/def 123"), "abc-def-123");
	assert.equal(sanitizePart("***"), "unknown");
});

test("collectCleanupPlan blocks the current attached session", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "current-session");
	const plan = collectCleanupPlan({ ...session, isCurrent: true }, { home, tmpdir: os.tmpdir() });
	assert.equal(plan.blocked, true);
	assert.match(plan.blockReason, /current/i);
	assert.equal(plan.items.length, 0);
});

test("collectCleanupPlan includes only known artifacts from recorded cwd and allowlisted roots", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "abc/def 123");
	const safeId = sanitizePart(session.id);

	writeFile(path.join(home, ".pi", "agent", ".scratch", "compactions", `${safeId}-global`, "summary.md"));
	writeFile(path.join(home, ".pi", "agent", ".scratch", "slipstream-stats", "sessions", `${safeId}.jsonl`));
	writeFile(path.join(session.cwd, ".scratch", "compactions", `${safeId}-project`, "summary.md"));
	writeFile(path.join(session.effectiveCwd, ".scratch", "compactions", `${safeId}-override-must-not-match`, "summary.md"));
	writeFile(path.join(path.dirname(session.file), path.basename(session.file, ".jsonl"), "run-1", "child.jsonl"));

	const plan = collectCleanupPlan(session, { home, tmpdir: os.tmpdir() });
	const itemPaths = plan.items.map((item) => item.path).sort();

	assert.equal(plan.blocked, false);
	assert.deepEqual(itemPaths, [
		session.file,
		path.join(home, ".pi", "agent", ".scratch", "compactions", `${safeId}-global`),
		path.join(home, ".pi", "agent", ".scratch", "slipstream-stats", "sessions", `${safeId}.jsonl`),
		path.join(path.dirname(session.file), path.basename(session.file, ".jsonl")),
		path.join(session.cwd, ".scratch", "compactions", `${safeId}-project`),
	].sort());
	assert.equal(itemPaths.some((p) => p.includes("override-must-not-match")), false);
});

test("collectCleanupPlan parses async dirs only from allowed one-level subagent run paths", () => {
	const { home } = makeTempHome();
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pisesh-async-"));
	const session = makeSession(home, "async-session");
	const currentRun = path.join(tmpRoot, "pi-subagents-user-orestes", "async-subagent-runs", "run-current");
	const legacyRun = path.join(tmpRoot, "pi-subagents-uid-1000", "async-subagent-runs", "run-legacy");
	const nestedFile = path.join(tmpRoot, "pi-subagents-user-orestes", "async-subagent-runs", "run-current", "nested", "file");
	const badRun = path.join(tmpRoot, "not-subagents", "async-subagent-runs", "run-bad");
	writeFile(path.join(currentRun, "status.json"));
	writeFile(path.join(legacyRun, "status.json"));
	writeFile(nestedFile);
	writeFile(path.join(badRun, "status.json"));
	fs.appendFileSync(session.file, `Async dir: ${currentRun}\nAsync dir: ${legacyRun}\nNested should not add: ${nestedFile}\nBad: ${badRun}\n`);

	const plan = collectCleanupPlan(session, { home, tmpdir: tmpRoot, env: { USER: "orestes" }, getuid: undefined });
	const asyncItems = plan.items.filter((item) => item.type === "subagent-async-run").map((item) => item.path).sort();
	assert.deepEqual(asyncItems, [currentRun, legacyRun].sort());
});

test("collectCleanupPlan does not infer async run from nested-only paths", () => {
	const { home } = makeTempHome();
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pisesh-async-nested-"));
	const session = makeSession(home, "async-nested-session");
	const currentRun = path.join(tmpRoot, "pi-subagents-user-orestes", "async-subagent-runs", "run-current");
	const nestedFile = path.join(currentRun, "nested", "file");
	writeFile(nestedFile);
	fs.appendFileSync(session.file, `Nested should not add: ${nestedFile}\n`);

	const plan = collectCleanupPlan(session, { home, tmpdir: tmpRoot, env: { USER: "orestes" }, getuid: undefined });
	const asyncItems = plan.items.filter((item) => item.type === "subagent-async-run").map((item) => item.path);
	assert.deepEqual(asyncItems, []);
});

test("collectCleanupPlan does not infer async run from nested-only Windows-style paths", () => {
	const { home } = makeTempHome();
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pisesh-async-win-nested-"));
	const session = makeSession(home, "async-windows-nested-session");
	const currentRun = path.join(tmpRoot, "pi-subagents-user-orestes", "async-subagent-runs", "run-current");
	const nestedFile = path.join(currentRun, "nested", "file");
	writeFile(nestedFile);
	fs.appendFileSync(session.file, `Nested should not add: ${nestedFile.replace(/[\\/]+/g, "\\")}\n`);

	const plan = collectCleanupPlan(session, { home, tmpdir: tmpRoot, env: { USER: "orestes" }, getuid: undefined });
	const asyncItems = plan.items.filter((item) => item.type === "subagent-async-run").map((item) => item.path);
	assert.deepEqual(asyncItems, []);
});

test("collectCleanupPlan parses Windows-style async run separators", () => {
	const { home } = makeTempHome();
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pisesh-async-win-"));
	const session = makeSession(home, "async-windows-session");
	const currentRun = path.join(tmpRoot, "pi-subagents-user-orestes", "async-subagent-runs", "run-current");
	const windowsStyleRun = currentRun.replace(/[\\/]+/g, "\\");
	writeFile(path.join(currentRun, "status.json"));
	fs.appendFileSync(session.file, `Async dir: ${windowsStyleRun}\n`);

	const plan = collectCleanupPlan(session, { home, tmpdir: tmpRoot, env: { USER: "orestes" }, getuid: undefined });
	const asyncItems = plan.items.filter((item) => item.type === "subagent-async-run").map((item) => item.path);
	assert.deepEqual(asyncItems, [currentRun]);
});

test("performCleanupPlan preserves metadata when session deletion fails", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "keep-metadata-session");
	writeFile(path.join(home, ".pi", "agent", "favorites.json"), JSON.stringify({ ids: [session.id, "other"] }));
	writeFile(path.join(home, ".pi", "agent", "pisesh-meta.json"), JSON.stringify({ overrides: { [session.id]: { title: "Keep me" }, other: { title: "Keep" } } }));
	const plan = collectCleanupPlan(session, { home, tmpdir: os.tmpdir() });
	const originalUnlinkSync = fs.unlinkSync;
	fs.unlinkSync = (filePath) => {
		if (filePath === session.file) {
			const error = new Error("simulated session deletion failure");
			error.code = "EACCES";
			throw error;
		}
		return originalUnlinkSync(filePath);
	};
	try {
		const result = performCleanupPlan(plan, { home, useTrash: false });
		assert.equal(result.ok, false);
		assert.equal(result.metadataChanged, false);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "favorites.json"), "utf8")).ids, [session.id, "other"]);
		assert.deepEqual(
			Object.keys(JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "pisesh-meta.json"), "utf8")).overrides).sort(),
			[session.id, "other"].sort(),
		);
	} finally {
		fs.unlinkSync = originalUnlinkSync;
	}
});

test("performCleanupPlan reports metadata parse failures", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "metadata-parse-fail-session");
	writeFile(path.join(home, ".pi", "agent", "favorites.json"), "not-json");
	writeFile(path.join(home, ".pi", "agent", "pisesh-meta.json"), "not-json");
	const plan = collectCleanupPlan(session, { home, tmpdir: os.tmpdir() });
	const result = performCleanupPlan(plan, { home, useTrash: false });
	assert.equal(result.ok, false);
	assert.equal(result.metadataChanged, false);
	assert.equal(result.failed.filter((item) => item.type === "pisesh-metadata").length, 2);
});

test("performCleanupPlan reports metadata write failures", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "metadata-fail-session");
	writeFile(path.join(home, ".pi", "agent", "favorites.json"), JSON.stringify({ ids: [session.id, "other"] }));
	writeFile(path.join(home, ".pi", "agent", "pisesh-meta.json"), JSON.stringify({ overrides: { [session.id]: { title: "Delete me" }, other: { title: "Keep" } } }));
	const plan = collectCleanupPlan(session, { home, tmpdir: os.tmpdir() });
	const originalWriteFileSync = fs.writeFileSync;
	fs.writeFileSync = (filePath, ...args) => {
		if (filePath.endsWith("favorites.json") || filePath.endsWith("pisesh-meta.json")) {
			const error = new Error("simulated metadata write failure");
			error.code = "EACCES";
			throw error;
		}
		return originalWriteFileSync(filePath, ...args);
	};
	try {
		const result = performCleanupPlan(plan, { home, useTrash: false });
		assert.equal(result.ok, false);
		assert.equal(result.metadataChanged, false);
		assert.equal(result.failed.filter((item) => item.type === "pisesh-metadata").length, 2);
	} finally {
		fs.writeFileSync = originalWriteFileSync;
	}
});

test("performCleanupPlan removes files, dirs, and pisesh metadata entries", () => {
	const { home } = makeTempHome();
	const session = makeSession(home, "delete-session");
	const compaction = path.join(home, ".pi", "agent", ".scratch", "compactions", `${sanitizePart(session.id)}-x`);
	writeFile(path.join(compaction, "summary.md"));
	writeFile(path.join(home, ".pi", "agent", "favorites.json"), JSON.stringify({ ids: [session.id, "other"] }));
	writeFile(path.join(home, ".pi", "agent", "pisesh-meta.json"), JSON.stringify({ overrides: { [session.id]: { title: "Delete me" }, other: { title: "Keep" } } }));

	const plan = collectCleanupPlan(session, { home, tmpdir: os.tmpdir() });
	const result = performCleanupPlan(plan, { home, useTrash: false });

	assert.equal(result.ok, true);
	assert.equal(fs.existsSync(session.file), false);
	assert.equal(fs.existsSync(compaction), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "favorites.json"), "utf8")).ids, ["other"]);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "pisesh-meta.json"), "utf8")).overrides), ["other"]);
});
