const AUTH_STATUSES = new Set([401, 403]);
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

export function tileLoadFailureStatus(event) {
  for (const candidate of [event?.status, event?.error?.status, event?.error?.response?.status]) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const message = String(event?.error?.message || event?.message || '');
  const match = message.match(/(?:http(?:\s+status)?|status|error\s+code)\D{0,12}(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

export function classifyTileLoadFailure(event) {
  const status = tileLoadFailureStatus(event);
  if (AUTH_STATUSES.has(status)) return { kind: 'authorization', status };
  if (TRANSIENT_STATUSES.has(status) || status >= 500) return { kind: 'transient', status };
  if (status !== null) return { kind: 'permanent', status };
  const message = String(event?.error?.message || event?.message || '').toLowerCase();
  if (/failed to fetch|network|timed?\s*out|connection|temporar|offline/.test(message)) {
    return { kind: 'transient', status: null };
  }
  return { kind: 'permanent', status: null };
}
