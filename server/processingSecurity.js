'use strict';

const path = require('node:path');

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function sanitizeLogMessage(value) {
  return String(value || '')
    .replace(/([?&](?:token|secret|signature|key|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:token|secret|signature|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(/(?:\b[A-Za-z]:\\|\/mnt\/|\/home\/|\/app\/)[^\s"']+/g, '[REDACTED PATH]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 64 * 1024);
}

function publicDerivativeKind(kind) {
  // Original datasets, provider archives, OBJ sources, LAZ/PLY point clouds,
  // logs and processing internals are administrative assets. Only selected,
  // reviewed derivatives may become client/public assets.
  return new Set(['glb','tiles','ept','ortho','dsm','dtm']).has(kind);
}

module.exports = { publicDerivativeKind, safeRelativePath, sanitizeLogMessage };
