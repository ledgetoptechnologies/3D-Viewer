const CHANNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_PATTERN = CHANNEL_ID_PATTERN;
const RENEWAL_LEAD_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function validContext(value) {
  return value && ['attemptId', 'modelId', 'modelVersionId'].every(key => (
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200
  )) && Number.isInteger(value.sessionTtlSeconds) && value.sessionTtlSeconds >= 60 && value.sessionTtlSeconds <= 86_400;
}

function validIssuedGrant(result, context) {
  return result && result.sessionMode === 'review'
    && result.attemptId === context.attemptId
    && result.modelId === context.modelId
    && result.modelVersionId === context.modelVersionId
    && result.sessionTtlSeconds === context.sessionTtlSeconds
    && GRANT_PATTERN.test(result.grant || '');
}

function validSessionExpiry(value, record, now, { afterCurrent = false } = {}) {
  const expiresAtMs = Date.parse(value || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return false;
  if (expiresAtMs > now + record.context.sessionTtlSeconds * 1000 + CLOCK_SKEW_MS) return false;
  if (afterCurrent && expiresAtMs <= record.expiresAtMs) return false;
  return true;
}

export class ReviewSessionController {
  constructor({
    origin,
    issueGrant,
    createChannel = name => new BroadcastChannel(name),
    now = () => Date.now(),
    retryDelays = [2_000, 5_000, 15_000],
    setTimer = (handler, delay) => setTimeout(handler, delay),
    clearTimer = timer => clearTimeout(timer),
  }) {
    if (typeof origin !== 'string' || !origin || new URL(origin).origin !== origin) throw new Error('invalid review controller origin');
    if (typeof issueGrant !== 'function' || typeof createChannel !== 'function') throw new Error('review channel dependencies are required');
    this.origin = origin;
    this.issueGrant = issueGrant;
    this.createChannel = createChannel;
    this.now = now;
    this.retryDelays = [...retryDelays].filter(delay => Number.isFinite(delay) && delay >= 0).slice(0, 3);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
  }

  track(channelId, context) {
    if (!CHANNEL_ID_PATTERN.test(channelId || '') || !validContext(context)) return false;
    this.untrack(channelId);
    const channel = this.createChannel(`ltds-viewer-review:${channelId}`);
    if (!channel || typeof channel.postMessage !== 'function' || typeof channel.close !== 'function') return false;
    const record = {
      channelId,
      channel,
      context: Object.freeze({
        attemptId: context.attemptId,
        modelId: context.modelId,
        modelVersionId: context.modelVersionId,
        sessionTtlSeconds: context.sessionTtlSeconds,
      }),
      expiresAt: null,
      expiresAtMs: 0,
      pending: false,
      awaitingRenewed: false,
      activeRequestId: null,
      usedRequestIds: new Set(),
      retryIndex: 0,
      retryTimer: null,
    };
    channel.onmessage = event => this.handleMessage(channelId, event?.data);
    this.records.set(channelId, record);
    return true;
  }

  has(channelId) { return this.records.has(channelId); }

  navigate(channelId, url) {
    const record = this.records.get(channelId);
    if (!record) return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    if (parsed.origin !== this.origin || parsed.username || parsed.password
      || !/^\/session\/[0-9a-f-]{36}$/i.test(parsed.pathname)
      || hash.get('reviewController') !== channelId) return false;
    record.channel.postMessage({ version: 1, type: 'ltds-viewer:navigate', url: parsed.href });
    return true;
  }

  untrack(channelId) {
    const record = this.records.get(channelId);
    if (!record) return false;
    if (record.retryTimer) this.clearTimer(record.retryTimer);
    record.channel.onmessage = null;
    record.channel.close();
    this.records.delete(channelId);
    return true;
  }

  async handleMessage(channelId, data) {
    const record = this.records.get(channelId);
    if (!record) return false;
    const now = this.now();
    if (exactKeys(data, ['version', 'type', 'modelId', 'expiresAt'])
      && data.version === 1 && data.type === 'ltds-viewer:ready' && data.modelId === record.context.modelId
      && validSessionExpiry(data.expiresAt, record, now)) {
      record.expiresAt = data.expiresAt;
      record.expiresAtMs = Date.parse(data.expiresAt);
      return true;
    }
    if (exactKeys(data, ['version', 'type', 'requestId', 'modelId', 'expiresAt'])
      && data.version === 1 && data.type === 'ltds-viewer:session-renewed'
      && data.modelId === record.context.modelId && data.requestId === record.activeRequestId
      && record.awaitingRenewed && validSessionExpiry(data.expiresAt, record, now, { afterCurrent: true })) {
      record.expiresAt = data.expiresAt;
      record.expiresAtMs = Date.parse(data.expiresAt);
      record.awaitingRenewed = false;
      record.activeRequestId = null;
      record.retryIndex = 0;
      return true;
    }
    if (exactKeys(data, ['version', 'type', 'requestId', 'modelId'])
      && data.version === 1 && data.type === 'ltds-viewer:session-renewal-failed'
      && data.modelId === record.context.modelId && data.requestId === record.activeRequestId
      && record.awaitingRenewed) {
      this.untrack(channelId);
      return true;
    }
    if (!exactKeys(data, ['version', 'type', 'requestId', 'modelId', 'expiresAt'])
      || data.version !== 1 || data.type !== 'ltds-viewer:session-expiring'
      || data.modelId !== record.context.modelId || data.expiresAt !== record.expiresAt
      || !CHANNEL_ID_PATTERN.test(data.requestId || '') || record.usedRequestIds.has(data.requestId)
      || record.pending || record.retryTimer || record.awaitingRenewed || !record.expiresAtMs
      || record.expiresAtMs <= now || record.expiresAtMs - now > RENEWAL_LEAD_MS) return false;
    if (record.usedRequestIds.size >= 32) record.usedRequestIds.delete(record.usedRequestIds.values().next().value);
    record.usedRequestIds.add(data.requestId);
    record.activeRequestId = data.requestId;
    return this.renew(record);
  }

  async renew(record) {
    if (this.records.get(record.channelId) !== record || record.pending || record.awaitingRenewed) return false;
    if (record.retryTimer) {
      this.clearTimer(record.retryTimer);
      record.retryTimer = null;
    }
    record.pending = true;
    try {
      const result = await this.issueGrant(record.context);
      if (!validIssuedGrant(result, record.context) || this.records.get(record.channelId) !== record) {
        this.untrack(record.channelId);
        return false;
      }
      record.retryIndex = 0;
      record.awaitingRenewed = true;
      record.channel.postMessage({ version: 1, type: 'ltds-viewer:renew-session', requestId: record.activeRequestId, grant: result.grant });
      return true;
    } catch (error) {
      if (error?.status === 401 || error?.status === 403 || error?.status === 410) {
        this.untrack(record.channelId);
        return false;
      }
      if (record.retryIndex < this.retryDelays.length) {
        const delay = this.retryDelays[record.retryIndex++];
        record.retryTimer = this.setTimer(() => this.renew(record), delay);
      }
      return false;
    } finally {
      record.pending = false;
    }
  }

  dispose() {
    for (const channelId of [...this.records.keys()]) this.untrack(channelId);
  }
}
