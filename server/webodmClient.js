// Minimal WebODM REST API client. Deliberately does NOT touch WebODM's
// Postgres DB — only the documented HTTP API (https://docs.webodm.org/api/),
// per the project handoff's guidance to avoid schema coupling.
'use strict';

const { config } = require('./config');

const TASK_STATUS = {
  QUEUED: 10,
  RUNNING: 20,
  FAILED: 30,
  COMPLETED: 40,
  CANCELED: 50,
};

let tokenCache = { token: null, fetchedAt: 0 };
// WebODM's default JWT_EXPIRATION_DELTA is 6h; refresh a bit early.
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

async function authenticate() {
  const url = `${config.webodmApiUrl}/api/token-auth/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.webodmUsername, password: config.webodmPassword }),
  });
  if (!res.ok) {
    throw new Error(`WebODM authentication failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body.token) throw new Error('WebODM authentication response missing token');
  tokenCache = { token: body.token, fetchedAt: Date.now() };
  return tokenCache.token;
}

async function getToken() {
  const isStale = !tokenCache.token || (Date.now() - tokenCache.fetchedAt) > TOKEN_TTL_MS;
  if (isStale) return authenticate();
  return tokenCache.token;
}

// Fetch wrapper that authenticates, retries once on a token-expiry response.
async function apiFetch(pathname, opts = {}, retried = false) {
  const token = await getToken();
  const res = await fetch(`${config.webodmApiUrl}${pathname}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `JWT ${token}` },
  });
  if ((res.status === 403 || res.status === 401) && !retried) {
    tokenCache = { token: null, fetchedAt: 0 };
    return apiFetch(pathname, opts, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WebODM API ${pathname} failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}

// Paginated list helper (WebODM's DRF pagination: {count, next, previous, results}).
async function listAllPages(pathname) {
  let out = [];
  let next = pathname;
  while (next) {
    const page = await apiFetch(next);
    if (Array.isArray(page)) { out = out.concat(page); break; } // non-paginated fallback
    out = out.concat(page.results || []);
    if (!page.next) break;
    // `next` from WebODM is a full URL; convert back to a path relative to webodmApiUrl.
    next = page.next.replace(config.webodmApiUrl, '');
  }
  return out;
}

async function listProjects() {
  return listAllPages('/api/projects/');
}

async function listTasks(projectId) {
  return listAllPages(`/api/projects/${projectId}/tasks/`);
}

module.exports = { TASK_STATUS, listProjects, listTasks, authenticate };
