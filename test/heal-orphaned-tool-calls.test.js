const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { buildResumeArgs, buildSelection, healOrphanedToolCalls, loadSessionSettings, scanSessions } = require('../bin/pisesh');
const PISESH = path.resolve(__dirname, '../bin/pisesh');
const temporaryDirectories = new Set();
test.after(() => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(id, parentId, message) {
  return { type: 'message', id, parentId, timestamp: '2026-07-20T00:00:00.000Z', message };
}

function assistant(id, stopReason, callId) {
  return entry(id, 'root', {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: {} }],
    stopReason,
  });
}

function writeSession(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-test-'));
  temporaryDirectories.add(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${entries.map(value => JSON.stringify(value)).join('\n')}\n`);
  return file;
}

function readSession(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    assert.fail(`invalid session fixture: ${error.message}`);
  }
}

test('resumes with the current default model and thinking level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-settings-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-5.6-sol',
    defaultThinkingLevel: 'medium',
  }));

  assert.deepEqual(buildResumeArgs({ id: 'session-id', file: '/sessions/session.jsonl' }, true, settingsFile), [
    '--session', 'session-id', '--session-dir', '/sessions',
    '--model', 'openai-codex/gpt-5.6-sol', '--thinking', 'medium',
  ]);
});

test('can resume with the model and thinking recorded in the session', () => {
  assert.deepEqual(buildResumeArgs({ id: 'session-id', file: '/sessions/session.jsonl' }, false), [
    '--session', 'session-id', '--session-dir', '/sessions',
  ]);
});

test('falls back to native session restore when settings are unavailable', () => {
  assert.deepEqual(buildResumeArgs({ id: 'session-id', file: '/sessions/session.jsonl' }, true, '/missing/settings.json'), [
    '--session', 'session-id', '--session-dir', '/sessions',
  ]);
});

test('returns a complete native-switch selection without spawning pi', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-selection-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-5.6-sol',
    defaultThinkingLevel: 'medium',
  }));
  const session = {
    file: path.join(dir, 'session.jsonl'),
    cwdOverride: '/work/override',
  };
  fs.writeFileSync(session.file, [
    JSON.stringify({ type: 'model_change', id: 'model', parentId: null, provider: 'anthropic', modelId: 'session-model' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'low' }),
  ].join('\n'));

  assert.deepEqual(buildSelection(session, true, 2, settingsFile), {
    version: 1,
    sessionPath: session.file,
    cwdOverride: '/work/override',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'medium',
    repaired: 2,
  });
  const hookSelection = buildSelection({
    ...session,
    id: 'selected-id',
    title: 'Selected exact title',
    cwd: '/decoded/project',
    effectiveCwd: '/work/override',
  }, true, 0, settingsFile, '/trusted/hook');
  assert.deepEqual(hookSelection.handoffHook, {
    executable: '/trusted/hook',
    session: {
      id: 'selected-id',
      path: path.resolve(session.file),
      title: 'Selected exact title',
      cwd: '/work/override',
    },
  });
  assert.deepEqual(buildSelection({ ...session, cwdOverride: undefined, id: 'flat-id', title: 'Flat title', cwd: '/flat/sessions', effectiveCwd: '/flat/sessions' }, true, 0, settingsFile, '/trusted/hook').handoffHook.session.cwd, '/flat/sessions');
  assert.deepEqual(buildSelection({ ...session, cwdOverride: undefined, id: 'decoded-id', title: 'Decoded title', cwd: '/decoded/project', effectiveCwd: '/decoded/project' }, true, 0, settingsFile, '/trusted/hook').handoffHook.session.cwd, '/decoded/project');
  assert.deepEqual(buildSelection(session, false), {
    version: 1,
    sessionPath: session.file,
    cwdOverride: '/work/override',
    model: 'anthropic/session-model',
    thinking: 'low',
  });
});

test('scans real session producers before building handoff metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-provenance-'));
  temporaryDirectories.add(root);
  const agentDir = path.join(root, 'agent');
  const sessionsDir = path.join(root, 'sessions');
  const decodedDir = path.join(sessionsDir, '--decoded-project-label--');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(decodedDir, { recursive: true });
  const fixtures = [
    { id: 'manual-id', dir: decodedDir, cwd: '/recorded/manual', prompt: 'Manual prompt' },
    { id: 'prompt-id', dir: decodedDir, cwd: '/recorded/prompt', prompt: 'Prompt fallback' },
    { id: 'current-session', dir: decodedDir, prompt: '' },
    { id: 'decoded-id', dir: decodedDir, prompt: '' },
    { id: 'flat-id', dir: sessionsDir, prompt: '' },
  ];
  for (const fixture of fixtures) {
    const file = path.join(fixture.dir, `${fixture.id}.jsonl`);
    const session = { type: 'session', id: fixture.id, timestamp: '2026-08-01T00:00:00.000Z' };
    if (fixture.cwd) session.cwd = fixture.cwd;
    const entries = [JSON.stringify(session)];
    if (fixture.prompt) entries.push(JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: fixture.prompt }] } }));
    fs.writeFileSync(file, `${entries.join('\n')}\n`);
  }
  fs.writeFileSync(path.join(agentDir, 'pisesh-meta.json'), JSON.stringify({ overrides: {
    'manual-id': { title: 'Manual sidecar title', cwd: '/override/manual' },
    'prompt-id': {},
  } }));

  const child = spawnSync(process.execPath, ['-e', `
    const { scanSessions, buildSelection } = require(${JSON.stringify(PISESH)});
    const rows = scanSessions();
    const selected = rows.map(row => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      effectiveCwd: row.effectiveCwd,
      selection: buildSelection(row, true, 0, undefined, '/trusted/hook'),
    }));
    process.stdout.write(JSON.stringify(selected));
  `], {
    env: {
      ...process.env,
      PI_AGENT_DIR: agentDir,
      PI_SESSION_DIR: sessionsDir,
      PISESH_CWD: '/flat/fallback',
      PISESH_CURRENT_SESSION: 'current-session',
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const rows = JSON.parse(child.stdout);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get('manual-id').title, 'Manual sidecar title');
  assert.equal(byId.get('prompt-id').title, 'Prompt fallback');
  assert.equal(byId.get('current-session').title, '(no prompt) current-');
  assert.equal(byId.get('manual-id').effectiveCwd, '/override/manual');
  assert.equal(byId.get('decoded-id').effectiveCwd, '/decoded/project/label');
  assert.equal(byId.get('flat-id').effectiveCwd, '/flat/fallback');
  for (const row of rows) {
    assert.equal(row.selection.handoffHook.session.title, row.title);
    assert.equal(row.selection.handoffHook.session.cwd, row.effectiveCwd);
  }
});
test('reads the active branch model and lets assistant metadata override older model changes', () => {
  const file = writeSession([
    { type: 'model_change', id: 'model', parentId: null, provider: 'anthropic', modelId: 'old-model' },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'high' },
    entry('assistant', 'thinking', {
      role: 'assistant', provider: 'openai', model: 'latest-model', content: [],
    }),
  ]);

  assert.deepEqual(loadSessionSettings(file), {
    model: 'openai/latest-model',
    thinking: 'high',
  });
});

test('supports custom agent and flat session directories, version, and stale cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-paths-'));
  temporaryDirectories.add(root);
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(agentDir, 'favorites.json'), JSON.stringify({ ids: ['keep-id', 'stale-id'] }));
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), `${JSON.stringify({
    type: 'session', id: 'keep-id', timestamp: '2026-08-01T00:00:00.000Z', cwd: root,
  })}\n`);

  const env = { ...process.env, PI_AGENT_DIR: agentDir, PI_SESSION_DIR: sessionDir };
  const cleaned = spawnSync(process.execPath, [PISESH, '--clean-favorites'], { env, encoding: 'utf8' });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.match(cleaned.stdout, /removed 1 stale favorite/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'favorites.json'))).ids, ['keep-id']);

  const version = spawnSync(process.execPath, [PISESH, '--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

for (const stopReason of ['error', 'aborted']) {
  test(`does not heal an ${stopReason} assistant tool call`, () => {
    const file = writeSession([
      assistant('assistant', stopReason, 'call-bad'),
      entry('user', 'assistant', { role: 'user', content: [{ type: 'text', text: 'continue' }] }),
    ]);

    assert.equal(healOrphanedToolCalls(file), 0);
    assert.deepEqual(readSession(file).map(value => value.message.role), ['assistant', 'user']);
  });
}

test('removes a previously injected result for an errored tool call', () => {
  const interrupted = entry('synthetic', 'assistant', {
    role: 'toolResult',
    toolCallId: 'call-bad',
    toolName: 'bash',
    content: [{ type: 'text', text: '[tool call interrupted: no result was recorded]' }],
    isError: true,
  });
  const file = writeSession([
    assistant('assistant', 'error', 'call-bad'),
    interrupted,
    entry('user', 'synthetic', { role: 'user', content: [{ type: 'text', text: 'continue' }] }),
  ]);

  assert.equal(healOrphanedToolCalls(file), 1);
  const healed = readSession(file);
  assert.deepEqual(healed.map(value => value.id), ['assistant', 'user']);
  assert.equal(healed[1].parentId, 'assistant');
  assert.equal(healOrphanedToolCalls(file), 0);
});

test('reports a session repair failure', () => {
  assert.throws(() => healOrphanedToolCalls('/missing/session.jsonl'), /session repair failed/);
});

test('still adds a result for a valid unfinished toolUse turn', () => {
  const file = writeSession([
    assistant('assistant', 'toolUse', 'call-good'),
    entry('user', 'assistant', { role: 'user', content: [{ type: 'text', text: 'continue' }] }),
  ]);

  assert.equal(healOrphanedToolCalls(file), 1);
  const healed = readSession(file);
  assert.deepEqual(healed.map(value => value.message.role), ['assistant', 'toolResult', 'user']);
  assert.equal(healed[1].message.toolCallId, 'call-good');
  assert.equal(healed[2].parentId, healed[1].id);
  assert.equal(healOrphanedToolCalls(file), 0);
});
