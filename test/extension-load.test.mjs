import test from "node:test";
import assert from "node:assert/strict";
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

test("packaged sesh extension entry loads and registers /sesh", async () => {
	const extension = await jiti.import("../extensions/sesh.ts");
	const registered = [];
	const pi = {
		registerCommand(name, spec) {
			registered.push({ name, spec });
		},
	};

	extension.default(pi);

	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "sesh");
	assert.equal(registered[0].spec.description, "Browse, star, and resume pi sessions (opens pisesh TUI)");
	assert.equal(typeof registered[0].spec.handler, "function");
});
