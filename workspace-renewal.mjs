export const WORKSPACE_RENEWAL_PROTOCOL_VERSION = 1;
export const WORKSPACE_RENEWAL_LEAD_MS = 5 * 60 * 1000;

const RESPONSE_TIMEOUT_MS = 10 * 1000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const GRANT_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9._:@-]{1,200}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function sessionEnvelope(value, expected = {}) {
  const session = value?.session;
  const expiresAtMs = Date.parse(session?.expiresAt || '');
  if (!session || !SESSION_ID_PATTERN.test(session.id || '') || !SUBJECT_PATTERN.test(session.subject || '') || !Number.isFinite(expiresAtMs)) throw new Error('invalid workspace session response');
  if (!exactHttpsOrigin(value?.controllerOrigin)) throw new Error('invalid workspace controller response');
  if (expected.origin && value.controllerOrigin !== expected.origin) throw new Error('workspace controller origin changed');
  if (expected.sessionId && session.id !== expected.sessionId) throw new Error('workspace session identity changed');
  if (expected.subject && session.subject !== expected.subject) throw new Error('workspace session subject changed');
  if (expected.accessToken && value.accessToken !== expected.accessToken) throw new Error('workspace bearer changed during renewal');
  if (value.accessToken !== undefined && !TOKEN_PATTERN.test(value.accessToken)) throw new Error('invalid workspace bearer');
  if (expiresAtMs <= Date.now()) throw new Error('workspace session expired');
  return { session, controllerOrigin: value.controllerOrigin, accessToken: value.accessToken, expiresAtMs };
}

export class WorkspaceSessionRenewal {
  constructor({
    controllerWindow,
    envelope,
    accessToken,
    fetchImpl = fetch,
    windowRef = window,
    documentRef = document,
    now = () => Date.now(),
    setTimer = (handler, delay) => setTimeout(handler, delay),
    clearTimer = (timer) => clearTimeout(timer),
    randomUUID = () => crypto.randomUUID(),
    onSession = () => {},
    onExpired = () => {},
  }) {
    const checked = sessionEnvelope({ ...envelope, accessToken: envelope.accessToken || accessToken });
    if (!TOKEN_PATTERN.test(accessToken || '')) throw new Error('invalid workspace bearer');
    this.controllerWindow = controllerWindow && !controllerWindow.closed ? controllerWindow : null;
    this.controllerOrigin = checked.controllerOrigin;
    this.protocolVersion = WORKSPACE_RENEWAL_PROTOCOL_VERSION;
    this.accessToken = accessToken;
    this.session = checked.session;
    this.expiresAtMs = checked.expiresAtMs;
    this.fetchImpl = fetchImpl;
    this.windowRef = windowRef;
    this.documentRef = documentRef;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.randomUUID = randomUUID;
    this.onSession = onSession;
    this.onExpired = onExpired;
    this.renewalTimer = null;
    this.expiryTimer = null;
    this.responseTimer = null;
    this.retryTimer = null;
    this.pendingRequestId = null;
    this.redemptionAttempt = null;
    this.retryAttempt = 0;
    this.disposed = false;
    this.boundMessage = (event) => this.handleMessage(event);
    this.boundFocus = () => this.requestIfDue('focus');
    this.boundVisibility = () => { if (this.documentRef.visibilityState === 'visible') this.requestIfDue('visibility'); };
    this.boundPageShow = () => this.requestIfDue('pageshow');
  }

  start() {
    this.windowRef.addEventListener('message', this.boundMessage);
    this.windowRef.addEventListener('focus', this.boundFocus);
    this.windowRef.addEventListener('pageshow', this.boundPageShow);
    this.documentRef.addEventListener('visibilitychange', this.boundVisibility);
    this.schedule();
    this.post({ type: 'ltds-viewer:workspace-ready', sessionId: this.session.id, subject: this.session.subject, expiresAt: this.session.expiresAt });
  }

  post(message) {
    if (!this.controllerWindow || this.controllerWindow.closed || this.disposed) return false;
    this.controllerWindow.postMessage({ version: this.protocolVersion, ...message }, this.controllerOrigin);
    return true;
  }

  schedule() {
    if (this.disposed) return;
    for (const timer of [this.renewalTimer, this.expiryTimer]) if (timer) this.clearTimer(timer);
    const remaining = this.expiresAtMs - this.now();
    if (remaining <= 0) {
      if (this.controllerWindow) return this.requestRenewal('late-schedule');
      return this.expire('expired');
    }
    this.expiryTimer = this.setTimer(() => {
      if (this.controllerWindow) this.requestRenewal('expiry');
      else this.expire('expired');
    }, remaining);
    if (this.controllerWindow) {
      this.renewalTimer = this.setTimer(() => this.requestRenewal('timer'), Math.max(1_000, remaining - WORKSPACE_RENEWAL_LEAD_MS));
    }
  }

  requestIfDue(reason) {
    if (this.expiresAtMs - this.now() <= WORKSPACE_RENEWAL_LEAD_MS) {
      // A later focus/visibility/pageshow is a new recovery opportunity after
      // a bounded transient retry run was exhausted while the tab slept.
      if (!this.pendingRequestId && this.retryAttempt >= RETRY_DELAYS_MS.length) this.retryAttempt = 0;
      this.requestRenewal(reason);
    }
  }

  requestRenewal(reason) {
    if (this.disposed || this.pendingRequestId || !this.controllerWindow) return false;
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      if (this.expiresAtMs <= this.now()) this.expire('expired');
      return false;
    }
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const requestId = this.randomUUID();
    this.pendingRequestId = requestId;
    this.retryAttempt += 1;
    if (!this.post({
      type: 'ltds-viewer:workspace-session-expiring',
      requestId,
      sessionId: this.session.id,
      subject: this.session.subject,
      expiresAt: this.session.expiresAt,
    })) {
      this.pendingRequestId = null;
      if (this.expiresAtMs <= this.now()) this.expire('expired');
      return false;
    }
    this.responseTimer = this.setTimer(() => {
      if (this.pendingRequestId !== requestId) return;
      this.pendingRequestId = null;
      this.responseTimer = null;
      this.postFailure('renewal response timed out', true, requestId);
      this.scheduleRetry();
    }, RESPONSE_TIMEOUT_MS);
    return true;
  }

  scheduleRetry() {
    if (this.disposed) return;
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      if (this.expiresAtMs <= this.now()) this.expire('expired');
      return;
    }
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    const delay = RETRY_DELAYS_MS[this.retryAttempt - 1];
    this.retryTimer = this.setTimer(() => this.requestRenewal('retry'), delay);
  }

  async handleMessage(event) {
    if (this.disposed || event.source !== this.controllerWindow || event.origin !== this.controllerOrigin) return;
    const message = event.data;
    if (!exactKeys(message, ['version','type','requestId','grant']) || message.version !== this.protocolVersion || message.type !== 'ltds-viewer:renew-workspace-session') return;
    if (message.requestId !== this.pendingRequestId || this.redemptionAttempt || !GRANT_PATTERN.test(message.grant || '')) return;
    const requestId = this.pendingRequestId;
    if (this.responseTimer) this.clearTimer(this.responseTimer);
    const attempt = { requestId, abortController: new AbortController() };
    this.redemptionAttempt = attempt;
    this.responseTimer = this.setTimer(() => {
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      attempt.abortController.abort();
      this.finishRequest(requestId);
      this.postFailure('workspace grant redemption timed out', true, requestId);
      this.scheduleRetry();
    }, RESPONSE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl('/api/v1/admin-sessions/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: message.grant }),
        signal: attempt.abortController.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      if (response.status === 401) {
        this.finishRequest(requestId);
        this.postFailure('workspace authorization expired', false, requestId);
        this.expire('unauthorized');
        return;
      }
      if (!response.ok) throw new Error(body.error || `renewal failed (${response.status})`);
      const checked = sessionEnvelope(body, {
        origin: this.controllerOrigin,
        sessionId: this.session.id,
        subject: this.session.subject,
        accessToken: this.accessToken,
      });
      this.finishRequest(requestId);
      this.session = checked.session;
      this.expiresAtMs = checked.expiresAtMs;
      this.retryAttempt = 0;
      if (this.retryTimer) this.clearTimer(this.retryTimer);
      this.retryTimer = null;
      this.schedule();
      this.onSession(body);
      this.post({
        type: 'ltds-viewer:workspace-session-renewed',
        requestId,
        sessionId: this.session.id,
        subject: this.session.subject,
        expiresAt: this.session.expiresAt,
      });
    } catch (error) {
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      this.finishRequest(requestId);
      this.postFailure(String(error?.message || error), true, requestId);
      this.scheduleRetry();
    }
  }

  finishRequest(requestId) {
    if (this.pendingRequestId !== requestId) return false;
    if (this.responseTimer) this.clearTimer(this.responseTimer);
    this.responseTimer = null;
    this.pendingRequestId = null;
    this.redemptionAttempt = null;
    return true;
  }

  postFailure(error, retryable, requestId) {
    this.post({
      type: 'ltds-viewer:workspace-session-renewal-failed',
      requestId,
      retryable,
    });
  }

  expire(reason) {
    if (this.disposed) return false;
    this.dispose();
    this.onExpired(reason);
    return false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.redemptionAttempt?.abortController.abort();
    this.redemptionAttempt = null;
    for (const timer of [this.renewalTimer, this.expiryTimer, this.responseTimer, this.retryTimer]) if (timer) this.clearTimer(timer);
    this.windowRef.removeEventListener('message', this.boundMessage);
    this.windowRef.removeEventListener('focus', this.boundFocus);
    this.windowRef.removeEventListener('pageshow', this.boundPageShow);
    this.documentRef.removeEventListener('visibilitychange', this.boundVisibility);
    this.pendingRequestId = null;
  }
}

export function validateWorkspaceSessionEnvelope(value, expected) {
  return sessionEnvelope(value, expected);
}
