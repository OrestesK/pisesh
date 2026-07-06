'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sanitizePart(value) {
  const sanitized = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function sanitizeTempScopeSegment(value) {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function resolveTempScopeId(options = {}) {
  const env = options.env || process.env;
  const getuid = Object.prototype.hasOwnProperty.call(options, 'getuid') ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === 'function') return `uid-${getuid()}`;
  for (const key of ['USERNAME', 'USER', 'LOGNAME']) {
    if (env[key]) return `user-${sanitizeTempScopeSegment(env[key])}`;
  }
  try {
    const username = (options.userInfo || os.userInfo)?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {}
  const homedir = env.USERPROFILE || env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
  try {
    const fallback = (options.homedir || os.homedir)?.();
    if (fallback) return `home-${sanitizeTempScopeSegment(fallback)}`;
  } catch {}
  return 'shared';
}

function makeDefaultPaths(options = {}) {
  const home = options.home || os.homedir();
  const tmpdir = options.tmpdir || os.tmpdir();
  const agentRoot = path.join(home, '.pi', 'agent');
  const tempScope = resolveTempScopeId(options);
  return {
    home,
    tmpdir,
    agentRoot,
    sessionsRoot: path.join(agentRoot, 'sessions'),
    centralCompactions: path.join(agentRoot, '.scratch', 'compactions'),
    slipstreamSessionStats: path.join(agentRoot, '.scratch', 'slipstream-stats', 'sessions'),
    currentAsyncRuns: path.join(tmpdir, `pi-subagents-${tempScope}`, 'async-subagent-runs'),
    legacyAsyncRuns: [path.join(tmpdir, 'pi-subagents-uid-1000', 'async-subagent-runs')],
    favoritesFile: path.join(agentRoot, 'favorites.json'),
    metaFile: path.join(agentRoot, 'pisesh-meta.json'),
  };
}

function realpathIfExists(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function isSubpath(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function isSafeExistingPath(target, allowedRoots) {
  let st;
  try { st = fs.lstatSync(target); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  const realTarget = realpathIfExists(target);
  if (!realTarget) return false;
  return allowedRoots.some((root) => {
    const realRoot = realpathIfExists(root);
    return realRoot ? isSubpath(realTarget, realRoot) : false;
  });
}

function sizeBytes(target) {
  let total = 0;
  function walk(p) {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    total += st.size;
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    let entries;
    try { entries = fs.readdirSync(p); } catch { return; }
    for (const entry of entries) walk(path.join(p, entry));
  }
  walk(target);
  return total;
}

function addCandidate(items, seen, candidate, allowedRoots) {
  if (!candidate.path || seen.has(candidate.path)) return;
  if (!fs.existsSync(candidate.path)) return;
  if (!isSafeExistingPath(candidate.path, allowedRoots)) return;
  seen.add(candidate.path);
  items.push({ ...candidate, size: sizeBytes(candidate.path) });
}

function addPrefixDirs(items, seen, root, prefix, type, reason, allowedRoots) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    addCandidate(items, seen, { path: path.join(root, entry.name), type, reason }, allowedRoots);
  }
}

function pathRegexPattern(p) {
  return p
    .split(/[\\/]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
}

function normalizeMatchedPath(p) {
  return path.normalize(p.replace(/[\\/]+/g, path.sep));
}

function parseAsyncRunDirs(sessionFile, tmpdir) {
  let text;
  try { text = fs.readFileSync(sessionFile, 'utf8'); } catch { return []; }
  const tmpPattern = pathRegexPattern(path.normalize(tmpdir));
  const re = new RegExp(`${tmpPattern}[\\\\/]pi-subagents-[A-Za-z0-9._-]+[\\\\/]async-subagent-runs[\\\\/][A-Za-z0-9._-]+(?![\\\\/])`, 'g');
  return [...new Set((text.match(re) || []).map(normalizeMatchedPath))];
}

function collectCleanupPlan(session, options = {}) {
  const paths = makeDefaultPaths(options);
  const items = [];
  const seen = new Set();
  if (!session || !session.id || !session.file) {
    return { blocked: true, blockReason: 'No session selected', items, session, totalSize: 0 };
  }
  if (session.isCurrent) {
    return { blocked: true, blockReason: 'Cannot clean up the currently attached session', items, session, totalSize: 0 };
  }

  const safeId = sanitizePart(session.id);
  const baseAllowedRoots = [paths.sessionsRoot, paths.centralCompactions, paths.slipstreamSessionStats];
  const recordedCwd = session.cwd || '';
  const projectCompactions = recordedCwd ? path.join(recordedCwd, '.scratch', 'compactions') : null;
  if (projectCompactions) baseAllowedRoots.push(projectCompactions);

  addCandidate(items, seen, { path: session.file, type: 'session', reason: 'selected session JSONL' }, [paths.sessionsRoot]);

  const siblingSubagentSessions = path.join(path.dirname(session.file), path.basename(session.file, '.jsonl'));
  addCandidate(items, seen, {
    path: siblingSubagentSessions,
    type: 'subagent-session-tree',
    reason: 'subagent child sessions stored beside parent session file',
  }, [paths.sessionsRoot]);

  addPrefixDirs(items, seen, paths.centralCompactions, `${safeId}-`, 'compaction', 'central Pi compaction artifact', baseAllowedRoots);
  if (projectCompactions) {
    addPrefixDirs(items, seen, projectCompactions, `${safeId}-`, 'compaction', 'recorded-cwd project compaction artifact', baseAllowedRoots);
  }

  addCandidate(items, seen, {
    path: path.join(paths.slipstreamSessionStats, `${safeId}.jsonl`),
    type: 'slipstream-stats',
    reason: 'Slipstream per-session stats file',
  }, baseAllowedRoots);

  const asyncRoots = [paths.currentAsyncRuns, ...paths.legacyAsyncRuns];
  const parsedAsync = parseAsyncRunDirs(session.file, paths.tmpdir);
  for (const asyncPath of parsedAsync) {
    const allowed = asyncRoots.some((root) => isSubpath(asyncPath, root));
    if (!allowed) continue;
    const parent = path.dirname(asyncPath);
    if (!asyncRoots.some((root) => path.resolve(parent) === path.resolve(root))) continue;
    addCandidate(items, seen, {
      path: asyncPath,
      type: 'subagent-async-run',
      reason: 'exact subagent async run path parsed from session JSONL',
    }, asyncRoots);
  }

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  return { blocked: false, blockReason: '', items, session, totalSize };
}

function removeFromJsonFiles(sessionId, options = {}) {
  const paths = makeDefaultPaths(options);
  let changed = false;
  const failed = [];
  try {
    const data = JSON.parse(fs.readFileSync(paths.favoritesFile, 'utf8'));
    const ids = Array.isArray(data.ids) ? data.ids.filter((id) => id !== sessionId) : [];
    if (JSON.stringify(ids) !== JSON.stringify(data.ids || [])) {
      try {
        fs.writeFileSync(paths.favoritesFile, JSON.stringify({ ...data, ids, updated: new Date().toISOString() }, null, 2));
        changed = true;
      } catch (error) {
        failed.push({ path: paths.favoritesFile, type: 'pisesh-metadata', reason: 'favorites metadata cleanup', error: error.message || String(error) });
      }
    }
  } catch (error) {
    if (fs.existsSync(paths.favoritesFile)) {
      failed.push({ path: paths.favoritesFile, type: 'pisesh-metadata', reason: 'favorites metadata cleanup', error: error.message || String(error) });
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(paths.metaFile, 'utf8'));
    if (data.overrides && Object.prototype.hasOwnProperty.call(data.overrides, sessionId)) {
      delete data.overrides[sessionId];
      try {
        fs.writeFileSync(paths.metaFile, JSON.stringify({ ...data, updated: new Date().toISOString() }, null, 2));
        changed = true;
      } catch (error) {
        failed.push({ path: paths.metaFile, type: 'pisesh-metadata', reason: 'override metadata cleanup', error: error.message || String(error) });
      }
    }
  } catch (error) {
    if (fs.existsSync(paths.metaFile)) {
      failed.push({ path: paths.metaFile, type: 'pisesh-metadata', reason: 'override metadata cleanup', error: error.message || String(error) });
    }
  }
  return { changed, failed };
}

function trashPath(target) {
  const trashArgs = target.startsWith('-') ? ['--', target] : [target];
  const trash = spawnSync('trash', trashArgs, { encoding: 'utf8' });
  if (trash.status === 0 || !fs.existsSync(target)) return { ok: true, method: 'trash' };

  const trashPut = spawnSync('trash-put', trashArgs, { encoding: 'utf8' });
  if (trashPut.status === 0 || !fs.existsSync(target)) return { ok: true, method: 'trash-put' };

  const gio = spawnSync('gio', ['trash', target], { encoding: 'utf8' });
  if (gio.status === 0 || !fs.existsSync(target)) return { ok: true, method: 'gio trash' };

  const errors = [trash, trashPut, gio]
    .map((result) => result.error?.message || result.stderr?.trim())
    .filter(Boolean)
    .join(' · ');
  return { ok: false, method: 'trash', error: errors || 'trash commands failed' };
}

function deletePath(target, options = {}) {
  if (options.useTrash !== false) {
    const trashed = trashPath(target);
    if (trashed.ok) return trashed;
  }
  try {
    const st = fs.lstatSync(target);
    if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
    return { ok: true, method: 'unlink' };
  } catch (err) {
    return { ok: false, method: 'unlink', error: err && err.message ? err.message : String(err) };
  }
}

function performCleanupPlan(plan, options = {}) {
  if (!plan || plan.blocked) {
    return { ok: false, error: plan?.blockReason || 'Cleanup is blocked', deleted: [], failed: [] };
  }
  const deleted = [];
  const failed = [];
  for (const item of plan.items) {
    if (!fs.existsSync(item.path)) continue;
    const result = deletePath(item.path, options);
    if (result.ok) deleted.push({ ...item, method: result.method });
    else failed.push({ ...item, error: result.error || 'unknown error' });
  }
  const sessionItem = plan.items.find((item) => item.type === 'session' && item.path === plan.session.file);
  const sessionDeleted = !sessionItem || deleted.some((item) => item.type === 'session' && item.path === plan.session.file);
  const metadata = sessionDeleted ? removeFromJsonFiles(plan.session.id, options) : { changed: false, failed: [] };
  failed.push(...metadata.failed);
  return { ok: failed.length === 0, deleted, failed, metadataChanged: metadata.changed };
}

module.exports = {
  collectCleanupPlan,
  performCleanupPlan,
  sanitizePart,
  resolveTempScopeId,
  makeDefaultPaths,
};
