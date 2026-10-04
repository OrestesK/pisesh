'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const HANDOFF_HOOK_OPTION = '--handoff-hook=';
const STDERR_LIMIT = 2048;

function hookPathError() {
  return new Error('expected --handoff-hook=<absolute path>');
}

function resolveHandoffHook(argv = [], env = process.env) {
  if (argv.includes('--handoff-hook')) throw hookPathError();

  const options = argv.filter(arg => arg.startsWith(HANDOFF_HOOK_OPTION));
  if (options.length > 1) throw new Error('--handoff-hook may be provided only once');
  if (options.length === 1) {
    const executable = options[0].slice(HANDOFF_HOOK_OPTION.length);
    if (!executable || !path.isAbsolute(executable)) throw hookPathError();
    return { executable };
  }

  const executable = env.PISESH_HANDOFF_HOOK;
  if (executable === undefined) return {};
  if (!executable || !path.isAbsolute(executable)) {
    return {
      warning: 'ignoring PISESH_HANDOFF_HOOK: expected an absolute executable path',
    };
  }
  return { executable };
}

function parseSeshHandoffHookArgs(raw) {
  const args = raw.trim();
  if (!args) return undefined;
  if (!args.startsWith(HANDOFF_HOOK_OPTION)) {
    throw new Error('/sesh only supports --handoff-hook=<absolute path>');
  }
  const executable = args.slice(HANDOFF_HOOK_OPTION.length);
  if (!executable || !path.isAbsolute(executable)) throw hookPathError();
  return executable;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validSession(value) {
  return isRecord(value)
    && hasExactKeys(value, ['cwd', 'id', 'path', 'title'])
    && typeof value.id === 'string'
    && typeof value.path === 'string'
    && path.isAbsolute(value.path)
    && typeof value.title === 'string'
    && typeof value.cwd === 'string';
}

function parseHandoffHookDescriptor(value) {
  if (value === undefined) return undefined;
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['executable', 'session'])
    || typeof value.executable !== 'string'
    || !path.isAbsolute(value.executable)
    || !validSession(value.session)
  ) {
    throw new Error('invalid handoff hook descriptor');
  }
  return value;
}

function createHandoffHookDescriptor(executable, session) {
  return parseHandoffHookDescriptor({
    executable,
    session: {
      id: session.id,
      path: session.path,
      title: session.title,
      cwd: session.cwd,
    },
  });
}

function buildHandoffPayload(session, source) {
  if (source !== 'cli' && source !== 'sesh') {
    throw new Error('invalid handoff source');
  }
  if (!validSession(session)) {
    throw new Error('invalid handoff session');
  }
  return {
    version: 1,
    event: 'handoff',
    source,
    session: {
      id: session.id,
      path: session.path,
      title: session.title,
      cwd: session.cwd,
    },
  };
}

function failureWarning(message, stderr) {
  const details = stderr.trim();
  return details ? `${message}: ${details}` : message;
}

function runHandoffHook(executable, payload, env = process.env) {
  return new Promise(resolve => {
    let stderr = '';
    let stdinError = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(executable, [], {
        env,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, warning: `handoff hook failed to start: ${error.message}` });
      return;
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < STDERR_LIMIT) {
        stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
      }
    });
    child.stdin.on('error', error => {
      stdinError = error.message;
    });
    child.on('error', error => {
      finish({ ok: false, warning: `handoff hook failed to start: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      if (stdinError) {
        finish({
          ok: false,
          warning: failureWarning(`handoff hook stdin failed: ${stdinError}`, stderr),
        });
      } else if (signal) {
        finish({
          ok: false,
          warning: failureWarning(`handoff hook terminated by ${signal}`, stderr),
        });
      } else if (code !== 0) {
        finish({
          ok: false,
          warning: failureWarning(`handoff hook exited with code ${code}`, stderr),
        });
      } else {
        finish({ ok: true });
      }
    });

    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      stdinError = error.message;
      child.stdin.end();
    }
  });
}

module.exports = {
  HANDOFF_HOOK_OPTION,
  buildHandoffPayload,
  createHandoffHookDescriptor,
  parseHandoffHookDescriptor,
  parseSeshHandoffHookArgs,
  resolveHandoffHook,
  runHandoffHook,
};
