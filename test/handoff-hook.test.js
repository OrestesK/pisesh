'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildHandoffPayload,
  createHandoffHookDescriptor,
  parseHandoffHookDescriptor,
  parseSeshHandoffHookArgs,
  resolveHandoffHook,
  runHandoffHook,
} = require('../lib/handoff-hook');

const temporaryDirectories = new Set();
const temporaryFiles = new Set();
test.after(() => {
  for (const file of temporaryFiles) fs.rmSync(file, { force: true });
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true });
});

function absoluteHook(name = 'hook') {
  return path.resolve(os.tmpdir(), name);
}

function writeNodePreload(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-hook-'));
  temporaryDirectories.add(dir);
  const file = path.join(dir, 'preload.js');
  fs.writeFileSync(file, source);
  return { dir, file };
}

function nodeHookEnv(preload, extra = {}) {
  return {
    ...process.env,
    ...extra,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
  };
}

test('resolves one absolute CLI hook before the inherited hook', () => {
  const cli = absoluteHook('cli hook');
  const inherited = absoluteHook('inherited-hook');

  assert.deepEqual(
    resolveHandoffHook([`--handoff-hook=${cli}`], { PISESH_HANDOFF_HOOK: inherited }),
    { executable: cli },
  );
  assert.deepEqual(resolveHandoffHook([], { PISESH_HANDOFF_HOOK: inherited }), {
    executable: inherited,
  });
  assert.deepEqual(resolveHandoffHook([], {}), {});
});

test('rejects malformed CLI hook configuration and ignores invalid inherited configuration', () => {
  const hook = absoluteHook();

  assert.throws(() => resolveHandoffHook(['--handoff-hook'], {}), /--handoff-hook=<absolute path>/);
  assert.throws(() => resolveHandoffHook(['--handoff-hook='], {}), /absolute path/);
  assert.throws(() => resolveHandoffHook(['--handoff-hook=relative'], {}), /absolute path/);
  assert.throws(
    () => resolveHandoffHook([`--handoff-hook=${hook}`, `--handoff-hook=${hook}`], {}),
    /only once/,
  );
  assert.deepEqual(resolveHandoffHook([], { PISESH_HANDOFF_HOOK: 'relative' }), {
    warning: 'ignoring PISESH_HANDOFF_HOOK: expected an absolute executable path',
  });
});

test('parses the raw /sesh equals form without shell or repeated-option parsing', () => {
  const spaced = absoluteHook('My Hooks/hook');
  const optionLike = `${absoluteHook('a')} --handoff-hook=/b`;

  assert.equal(parseSeshHandoffHookArgs(''), undefined);
  assert.equal(parseSeshHandoffHookArgs('   '), undefined);
  assert.equal(parseSeshHandoffHookArgs(` --handoff-hook=${spaced} `), spaced);
  assert.equal(parseSeshHandoffHookArgs(`--handoff-hook=${optionLike}`), optionLike);
  assert.throws(() => parseSeshHandoffHookArgs('--handoff-hook='), /absolute path/);
  assert.throws(() => parseSeshHandoffHookArgs('--handoff-hook=relative'), /absolute path/);
  assert.throws(() => parseSeshHandoffHookArgs('--unknown=value'), /only supports --handoff-hook/);
  assert.throws(() => parseSeshHandoffHookArgs(`--handoff-hook "${spaced}"`), /only supports --handoff-hook/);
});

test('creates and strictly validates the private handoff descriptor', () => {
  const descriptor = createHandoffHookDescriptor(absoluteHook(), {
    id: 'session-id',
    path: '/sessions/session.jsonl',
    title: 'Exact pisesh title',
    cwd: '/work/project',
  });

  assert.deepEqual(parseHandoffHookDescriptor(descriptor), descriptor);
  assert.equal(parseHandoffHookDescriptor(undefined), undefined);
  assert.throws(
    () => parseHandoffHookDescriptor({ ...descriptor, source: 'cli' }),
    /invalid handoff hook descriptor/,
  );
  assert.throws(
    () => parseHandoffHookDescriptor({ ...descriptor, session: { ...descriptor.session, extra: true } }),
    /invalid handoff hook descriptor/,
  );
  assert.throws(
    () => parseHandoffHookDescriptor({ ...descriptor, executable: 'relative' }),
    /invalid handoff hook descriptor/,
  );
});

test('builds the exact versioned public payload at delivery time', () => {
  const session = {
    id: 'session-id',
    path: '/sessions/session.jsonl',
    title: 'Exact pisesh title',
    cwd: '/selected/cwd',
  };

  assert.deepEqual(buildHandoffPayload(session, 'cli'), {
    version: 1,
    event: 'handoff',
    source: 'cli',
    session,
  });
  assert.deepEqual(buildHandoffPayload(session, 'sesh'), {
    version: 1,
    event: 'handoff',
    source: 'sesh',
    session,
  });
  assert.throws(() => buildHandoffPayload(session, 'other'), /invalid handoff source/);
});

test('awaits a direct no-argument executable and sends one JSON line through stdin', async () => {
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-hook dir-'));
  temporaryDirectories.add(hookDir);
  const capture = path.join(hookDir, 'capture.json');
  const executable = path.join(hookDir, 'direct hook.js');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
setTimeout(() => {
  fs.writeFileSync(process.env.PISESH_HOOK_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    input,
    marker: process.env.PISESH_HOOK_MARKER,
  }));
  process.exit(0);
}, 25);
`);
  fs.chmodSync(executable, 0o755);
  const payload = buildHandoffPayload({
    id: 'session-id',
    path: '/sessions/session.jsonl',
    title: 'Sensitive title',
    cwd: '/selected/cwd',
  }, 'cli');

  const result = await runHandoffHook(executable, payload, {
    ...process.env,
    PISESH_HOOK_CAPTURE: capture,
    PISESH_HOOK_MARKER: 'inherited',
  });

  assert.deepEqual(result, { ok: true });
  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(observed.argv, []);
  assert.equal(observed.input, `${JSON.stringify(payload)}\n`);
  assert.equal(observed.marker, 'inherited');
});

test('returns bounded warnings for nonzero and launch failures', async () => {
  const { file: preload } = writeNodePreload(`
    const fs = require('node:fs');
    fs.readFileSync(0, 'utf8');
    process.stderr.write('x'.repeat(5000));
    process.exit(7);
  `);
  const payload = buildHandoffPayload({
    id: 'session-id',
    path: '/sessions/session.jsonl',
    title: 'Title',
    cwd: '/selected/cwd',
  }, 'sesh');

  const nonzero = await runHandoffHook(process.execPath, payload, nodeHookEnv(preload));
  assert.equal(nonzero.ok, false);
  assert.match(nonzero.warning, /exited with code 7/);
  assert.ok(nonzero.warning.length < 2300, `warning was ${nonzero.warning.length} characters`);

  const missing = await runHandoffHook(absoluteHook('missing-executable'), payload, process.env);
  assert.equal(missing.ok, false);
  assert.match(missing.warning, /failed to start/);
});

test('warns when the hook is terminated by a signal', async () => {
  const { file: preload } = writeNodePreload(`process.kill(process.pid, 'SIGTERM');`);
  const payload = buildHandoffPayload({ id: 'id', path: '/sessions/a.jsonl', title: 'Title', cwd: '/cwd' }, 'cli');
  const result = await runHandoffHook(process.execPath, payload, nodeHookEnv(preload));
  assert.equal(result.ok, false);
  assert.match(result.warning, /terminated by SIGTERM/);
});

test('warns when the hook closes stdin before delivery', async () => {
  const { file: preload } = writeNodePreload(`process.stdin.destroy(); setTimeout(() => process.exit(0), 20);`);
  const payload = buildHandoffPayload({ id: 'id', path: '/sessions/a.jsonl', title: 'x'.repeat(10_000_000), cwd: '/cwd' }, 'sesh');
  const result = await runHandoffHook(process.execPath, payload, nodeHookEnv(preload));
  assert.equal(result.ok, false);
  assert.match(result.warning, /stdin failed/);
});
