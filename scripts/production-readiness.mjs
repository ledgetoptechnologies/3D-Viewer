#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { config, validate } = require('../server/config');
const { signServiceRequest } = require('../server/serviceAuth');

function fail(message) {
  throw new Error(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function has(name) {
  return process.argv.includes(name);
}

function access(target, mode, label) {
  try {
    fs.accessSync(target, mode);
  } catch {
    fail(`${label} is not accessible at ${target}`);
  }
}

function decodedMountPath(value) {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
}

function mountedReadOnly(target) {
  if (!fs.existsSync('/proc/self/mountinfo')) return null;
  const resolved = path.resolve(target);
  const entries = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n');
  let best = null;
  for (const entry of entries) {
    const halves = entry.split(' - ');
    if (halves.length !== 2) continue;
    const left = halves[0].split(' ');
    const mountPoint = decodedMountPath(left[4] || '');
    if (resolved !== mountPoint && !resolved.startsWith(`${mountPoint}/`)) continue;
    if (!best || mountPoint.length > best.mountPoint.length) {
      best = {
        mountPoint,
        options: new Set([...(left[5] || '').split(','), ...(halves[1].split(' ')[2] || '').split(',')]),
      };
    }
  }
  return best ? best.options.has('ro') : null;
}

async function request(baseUrl, requestPath, init = {}) {
  const target = new URL(requestPath, baseUrl);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method: init.method || 'GET',
      headers: { Host: init.host || config.expectedHost, ...(init.headers || {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: new Headers(res.headers),
        async text() { return Buffer.concat(chunks).toString('utf8'); },
      }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function json(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function assetSummary(models) {
  const totals = { models: models.length, ready: 0, pointCloud: 0, lod: 0, verifiedLod: 0, fullMesh: 0 };
  for (const model of models) {
    if (model?.available) totals.ready += 1;
    if (model?.assets?.pointCloud || model?.assets?.ept) totals.pointCloud += 1;
    if (model?.assets?.tiles) totals.lod += 1;
    if (model?.assets?.glb || model?.assets?.obj) totals.fullMesh += 1;
    if (model?.assets?.tiles && model?.assets?.glb && model?.lodProvenance) totals.verifiedLod += 1;
  }
  return totals;
}

async function main() {
  const problems = validate();
  if (problems.length) fail(`invalid production configuration: ${problems.join('; ')}`);
  if (!config.production) fail('NODE_ENV must be production');
  if (config.emergencyAdminEnabled) fail('EMERGENCY_ADMIN_ENABLED must remain false');
  const authSecret = config.serviceAuthKeys?.[config.serviceAuthKeyId] || config.serviceAuthSecret;
  if (!authSecret) fail(`no service authentication secret is configured for ${config.serviceAuthKeyId}`);
  if (Object.values(config.serviceAuthKeys || { [config.serviceAuthKeyId]: authSecret }).includes(config.sessionSecret))
    fail('SESSION_SECRET and service authentication secrets must be independent');

  access(config.dataDir, fs.constants.R_OK | fs.constants.W_OK, 'Viewer data directory');
  if (config.webodmEnabled) access(config.webodmMediaMount, fs.constants.R_OK, 'WebODM media mount');
  if (config.derivativesMount) access(config.derivativesMount, fs.constants.R_OK, 'derivatives mount');

  if (has('--verify-mount-options')) {
    if (!config.derivativesMount) fail('DERIVATIVES_MOUNT is required when verifying mount options');
    const webodmReadOnly = mountedReadOnly(config.webodmMediaMount);
    const derivativesReadOnly = mountedReadOnly(config.derivativesMount);
    const dataReadOnly = mountedReadOnly(config.dataDir);
    if (webodmReadOnly !== true) fail('WebODM media mount is not read-only');
    if (derivativesReadOnly !== true) fail('derivatives mount is not read-only');
    if (dataReadOnly !== false) fail('Viewer data mount is not writable');
  }

  const baseUrl = option('--base-url') || process.env.VIEWER_READINESS_BASE_URL || `http://127.0.0.1:${config.port}`;
  const healthResponse = await request(baseUrl, '/api/v1/health');
  if (healthResponse.status !== 200 || (await json(healthResponse, 'health probe')).ok !== true)
    fail(`health probe returned HTTP ${healthResponse.status}`);

  const readyResponse = await request(baseUrl, '/api/v1/ready');
  const ready = await json(readyResponse, 'readiness probe');
  if (readyResponse.status !== 200 || ready.ok !== true || ready.missing?.length)
    fail(`readiness probe returned HTTP ${readyResponse.status}: ${(ready.missing || []).join(', ')}`);

  const root = await request(baseUrl, '/');
  const rootLocation = root.headers.get('location');
  let canonicalOpsRedirect = false;
  try {
    const parsed = new URL(rootLocation);
    canonicalOpsRedirect = parsed.origin === config.opsBaseUrl && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { /* invalid or missing Location */ }
  if (root.status !== 302 || !canonicalOpsRedirect)
    fail(`bare Viewer origin returned HTTP ${root.status} with Location ${rootLocation || '(missing)'}`);
  const admin = await request(baseUrl, '/api/admin/session');
  if (admin.status !== 404) fail(`legacy admin API returned HTTP ${admin.status}, expected 404`);
  const wrongHost = await request(baseUrl, '/', { host: 'invalid.example' });
  if (wrongHost.status !== 421) fail(`unexpected host returned HTTP ${wrongHost.status}, expected 421`);

  const catalogPath = '/api/v1/models';
  const authHeaders = signServiceRequest({
    secret: authSecret,
    keyId: config.serviceAuthKeyId,
    method: 'GET',
    path: catalogPath,
  });
  const catalogResponse = await request(baseUrl, catalogPath, { headers: authHeaders });
  if (catalogResponse.status !== 200) fail(`signed model catalog returned HTTP ${catalogResponse.status}`);
  const catalog = await json(catalogResponse, 'model catalog');
  if (!Array.isArray(catalog.models)) fail('model catalog did not return a models array');

  const selectedId = option('--model');
  const selected = selectedId ? catalog.models.find((model) => model.id === selectedId) : null;
  if (selectedId && !selected) fail(`required model ${selectedId} was not discovered`);
  const candidates = selected ? [selected] : catalog.models;
  const summary = assetSummary(candidates);
  if (has('--require-models') && summary.ready === 0) fail('no ready Viewer models were discovered');
  if (has('--require-point-cloud') && summary.pointCloud === 0) fail('no EPT/LAS/LAZ/PLY point cloud was discovered');
  if (has('--require-lod') && summary.verifiedLod === 0)
    fail('no LOD model with a full mesh and verified lod-provenance.json was discovered');

  const output = {
    ok: true,
    host: config.expectedHost,
    webodmMount: config.webodmMediaMount,
    derivativesMount: config.derivativesMount || null,
    ...summary,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Viewer readiness failed: ${error.message}\n`);
  process.exitCode = 1;
});
