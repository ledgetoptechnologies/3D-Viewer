const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

// This helper runs only in the authenticated workspace. Its narrowly scoped
// protocol does not give the model tab a generic fetch proxy or an admin token.
export function createMeasurementCalculationBroker({ origin, getAuthorization, fetchImpl = fetch }) {
  if (new URL(origin).origin !== origin || typeof getAuthorization !== 'function') throw new Error('invalid_measurement_broker');
  return async (context, message) => {
    const auth = getAuthorization();
    if (!auth?.accessToken || !auth.session?.subject || !auth.session.permissions?.includes('viewer.processing.write') || !Number.isFinite(Date.parse(auth.session.expiresAt)) || Date.parse(auth.session.expiresAt) <= Date.now()) fail('measurement_admin_required');
    if (!['capabilities','create','list','status','cancel'].includes(message.operation) || !/^[A-Za-z0-9_-]{32,128}$/.test(message.viewerToken || '') || !message.payload || JSON.stringify(message.payload).length > 16384) fail('measurement_request_invalid', 400);
    const payload = message.payload;
    const allowed = message.operation === 'capabilities' ? [] : message.operation === 'create' ? ['measurementId','request'] : message.operation === 'list' ? ['measurementId'] : ['measurementId','jobId'];
    if (!keys(payload, allowed) || (message.operation !== 'capabilities' && !UUID.test(payload.measurementId || '')) || (['status','cancel'].includes(message.operation) && !UUID.test(payload.jobId || ''))) fail('measurement_request_invalid', 400);
    const send = async (path, { method = 'GET', body, administrative = false } = {}) => {
      const response = await fetchImpl(`${origin}${path}`, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${message.viewerToken}`, Accept: 'application/json', ...(administrative ? { 'X-Viewer-Admin-Authorization': `Bearer ${auth.accessToken}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'measurement_admin_required' : 'measurement_request_failed', response.status);
      return response.status === 204 ? { cancelled: true } : response.json();
    };
    const viewer = await send('/api/v1/sessions/current');
    if (viewer.audience !== 'ops' || viewer.subject !== auth.session.subject || viewer.model?.id !== context.modelId || viewer.model?.activeVersion?.id !== context.modelVersionId || viewer.sessionMode !== (context.sessionMode || 'review') || (viewer.sessionMode === 'review' && viewer.reviewAttemptId !== context.attemptId) || viewer.permissions?.view !== true || viewer.permissions?.measure !== true || !Number.isFinite(Date.parse(viewer.expiresAt)) || Date.parse(viewer.expiresAt) <= Date.now()) fail('measurement_scope_changed');
    // A workspace sign-out or subject/token replacement during verification
    // must not dispatch a queued write under the preceding principal.
    const current = getAuthorization();
    if (current?.accessToken !== auth.accessToken || current?.session?.subject !== auth.session.subject || !current.session.permissions?.includes('viewer.processing.write')) fail('measurement_admin_required');
    if (message.operation === 'capabilities') return send('/api/v1/measurements/capabilities', { administrative: true });
    const base = `/api/v1/measurements/${encodeURIComponent(payload.measurementId)}/calculations`;
    if (message.operation === 'create') return send(base, { method: 'POST', body: payload.request, administrative: true });
    if (message.operation === 'list') return send(base, { administrative: true });
    return send(`${base}/${encodeURIComponent(payload.jobId)}`, { method: message.operation === 'cancel' ? 'DELETE' : 'GET', administrative: true });
  };
}
