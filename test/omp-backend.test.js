const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildResumeArgs,
  buildSelection,
  modelListArgs,
  parseBackendArgs,
  parseModelEntries,
  readSessionMeta,
  resolveBackendPaths,
  resolveToggledBackendPaths,
  titleGenerationArgs,
} = require('../bin/pisesh');
const { normalizeSwitchResult } = require('../lib/switch-result');

const temporaryDirectories = new Set();
test.after(() => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisesh-omp-'));
  temporaryDirectories.add(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

test('selects OMP from its entrypoint, flag, or environment without changing Pi defaults', () => {
  assert.deepEqual(parseBackendArgs([], 'pisesh', {}), { backend: 'pi', args: [] });
  assert.deepEqual(parseBackendArgs([], 'ompsesh', {}), { backend: 'omp', args: [] });
  assert.deepEqual(parseBackendArgs(['--omp', '--list'], 'pisesh', {}), { backend: 'omp', args: ['--list'] });
  assert.deepEqual(parseBackendArgs(['--backend=pi'], 'ompsesh', { PISESH_BACKEND: 'omp' }), { backend: 'pi', args: [] });
});

test('resolves the active OMP profile and ignores Pi-only directory variables', () => {
  const home = '/home/example';
  assert.deepEqual(resolveBackendPaths('omp', {
    OMP_PROFILE: 'work',
    PI_CONFIG_DIR: '.config/custom-omp',
    PI_AGENT_DIR: '/pi-only',
  }, home), {
    agentDir: '/home/example/.config/custom-omp/profiles/work/agent',
    sessionsRoot: '/home/example/.config/custom-omp/profiles/work/agent/sessions',
  });
  assert.deepEqual(resolveBackendPaths('omp', {
    PI_CODING_AGENT_DIR: '/active/omp',
    PI_CODING_AGENT_SESSION_DIR: '/active/sessions',
    PI_SESSION_DIR: '/pi-only/sessions',
  }, home), {
    agentDir: '/active/omp',
    sessionsRoot: '/active/sessions',
  });
});

test('isolates shared coding-agent paths when toggling to the other backend', () => {
  const home = '/home/example';
  const ompEnv = {
    PI_CODING_AGENT_DIR: '/active/omp',
    PI_CODING_AGENT_SESSION_DIR: '/active/omp-sessions',
  };
  assert.deepEqual(resolveToggledBackendPaths('omp', 'omp', ompEnv, home), {
    agentDir: '/active/omp',
    sessionsRoot: '/active/omp-sessions',
  });
  assert.deepEqual(resolveToggledBackendPaths('pi', 'omp', ompEnv, home), {
    agentDir: '/home/example/.pi/agent',
    sessionsRoot: '/home/example/.pi/agent/sessions',
  });

  assert.deepEqual(resolveToggledBackendPaths('omp', 'pi', {
    PI_CODING_AGENT_DIR: '/active/pi',
    PI_CODING_AGENT_SESSION_DIR: '/active/pi-sessions',
    PI_CONFIG_DIR: '.config/custom-omp',
    OMP_PROFILE: 'work',
  }, home), {
    agentDir: '/home/example/.config/custom-omp/profiles/work/agent',
    sessionsRoot: '/home/example/.config/custom-omp/profiles/work/agent/sessions',
  });
});

test('builds native OMP resume and switch payloads without Pi settings or repair metadata', () => {
  const settingsFile = temporaryFile('settings.json', JSON.stringify({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-5.6-sol',
    defaultThinkingLevel: 'high',
  }));
  const session = {
    id: 'session-id',
    file: '/sessions/session.jsonl',
    cwdOverride: '/work/override',
  };

  assert.deepEqual(buildResumeArgs(session, true, settingsFile, 'omp'), [
    '--resume', '/sessions/session.jsonl',
  ]);
  assert.deepEqual(buildSelection(session, true, 3, settingsFile, undefined, 'omp'), {
    version: 1,
    sessionPath: '/sessions/session.jsonl',
    cwdOverride: '/work/override',
  });
});

test('uses OMP native titles ahead of prompt fallback', () => {
  const file = temporaryFile('session.jsonl', [
    JSON.stringify({ type: 'title', title: 'Native OMP title' }),
    JSON.stringify({ type: 'session', id: 'session-id', timestamp: '2026-09-22T00:00:00.000Z', cwd: '/work' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'Prompt fallback' } }),
  ].join('\n'));

  assert.deepEqual(readSessionMeta(file), {
    type: 'session',
    id: 'session-id',
    timestamp: '2026-09-22T00:00:00.000Z',
    cwd: '/work',
    firstPrompt: 'Prompt fallback',
    nativeTitle: 'Native OMP title',
  });
});

test('uses OMP model discovery and isolated title-generation arguments', () => {
  const modelJson = JSON.stringify({ models: [
    { selector: 'openai-codex/gpt-5.6-sol', reasoning: true },
    { provider: 'anthropic', id: 'claude-sonnet', reasoning: false },
  ] });
  assert.deepEqual(modelListArgs('omp'), ['models', '--json']);
  assert.deepEqual(parseModelEntries(modelJson, 'omp'), [
    { id: 'openai-codex/gpt-5.6-sol', thinking: true },
    { id: 'anthropic/claude-sonnet', thinking: false },
  ]);

  const args = titleGenerationArgs('openai-codex/gpt-5.6-sol', 'low', 'prompt', 'omp');
  assert.deepEqual(args.slice(0, 4), ['--print', '--no-session', '--no-skills', '--no-tools']);
  assert.equal(args.includes('--no-context-files'), false);
  assert.equal(args.at(-1), 'prompt');
});

test('normalizes both Pi and OMP switch results', () => {
  assert.deepEqual(normalizeSwitchResult(true), { cancelled: false });
  assert.deepEqual(normalizeSwitchResult(false), { cancelled: true });
  assert.deepEqual(normalizeSwitchResult({ cancelled: true }), { cancelled: true });
  assert.deepEqual(normalizeSwitchResult({ cancelled: false }), { cancelled: false });
});
