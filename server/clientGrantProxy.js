'use strict';

const { signViewerEvent } = require('./viewerEvents');

const REMOTE_PATH = '/api/viewer/workspace/client-grants';
const LOCAL_PATH = '/api/v1/workspace/client-grants';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function invalid(res, message = 'client grant request is invalid') {
  return res.status(400).json({ error: message, code: 'invalid_client_grant_request' });
}
function validSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.grants) && value.grants.length <= 10_000
    && Array.isArray(value.projects) && value.projects.length <= 10_000
    && Array.isArray(value.associations) && value.associations.length <= 10_000
    && (value.replayed === undefined || typeof value.replayed === 'boolean');
}

function createClientGrantProxy({ config, authorize, fetchImpl = fetch }) {
  async function proxy(req, res, action) {
    if (!/^ops:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(req.adminPrincipal?.subject || '')))
      return res.status(403).json({ error: 'Viewer workspace authorization is invalid', code: 'invalid_workspace_subject' });
    const supplied = req.body || {};
    const envelope = { subject: req.adminPrincipal.subject, action };
    if (action === 'create') {
      const grant = supplied.grant;
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return invalid(res);
      if (!IDEMPOTENCY_KEY.test(String(req.get('Idempotency-Key') || ''))) return invalid(res, 'valid Idempotency-Key is required');
      envelope.idempotencyKey = req.get('Idempotency-Key');
      envelope.grant = grant;
    } else if (action === 'revoke') {
      if (!ID.test(String(supplied.grantId || '')) || typeof supplied.reason !== 'string' || !supplied.reason.trim() || supplied.reason.trim().length > 240)
        return invalid(res);
      if (!IDEMPOTENCY_KEY.test(String(req.get('Idempotency-Key') || ''))) return invalid(res, 'valid Idempotency-Key is required');
      envelope.idempotencyKey = req.get('Idempotency-Key');
      envelope.grantId = supplied.grantId;
      envelope.reason = supplied.reason.trim();
    }

    try {
      const body = JSON.stringify(envelope);
      const url = new URL(REMOTE_PATH, config.opsAutomationBaseUrl);
      if (url.origin !== config.opsAutomationBaseUrl || url.pathname !== REMOTE_PATH || url.search || url.hash || url.username || url.password)
        throw new Error('invalid_destination');
      const signed = signViewerEvent({ secret: config.viewerEventSecret, keyId: config.viewerEventKeyId, method: 'POST', path: REMOTE_PATH, body });
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { ...signed, Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
      });
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > 1024 * 1024) throw new Error('response_too_large');
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('response_too_large');
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('invalid_response'); }
      if (!response.ok) return res.status(response.status >= 400 && response.status < 500 ? response.status : 502)
        .json({ error: 'Operations rejected the client access request', code: 'operations_request_failed' });
      if (!validSnapshot(payload)) throw new Error('invalid_response');
      return res.status(action === 'create' && !payload.replayed ? 201 : 200).json(payload);
    } catch {
      return res.status(502).json({ error: 'Operations client access service is unavailable', code: 'operations_unavailable' });
    }
  }

  return {
    mount(router) {
      const allowed = authorize('viewer.client_grants.manage');
      router.get(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'list'));
      router.post(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'create'));
      router.delete(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'revoke'));
    },
  };
}

module.exports = { LOCAL_PATH, REMOTE_PATH, createClientGrantProxy };
