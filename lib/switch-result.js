'use strict';

function normalizeSwitchResult(result) {
  if (typeof result === 'boolean') return { cancelled: !result };
  if (result && typeof result === 'object' && typeof result.cancelled === 'boolean') {
    return { cancelled: result.cancelled };
  }
  return { cancelled: false };
}

module.exports = { normalizeSwitchResult };
