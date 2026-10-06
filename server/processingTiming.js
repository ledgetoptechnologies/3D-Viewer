'use strict';

// Provider elapsed engine time is milliseconds, not Viewer wall-clock time.
function providerDurationMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function elapsedMs(start, end) {
  const first = Date.parse(start || ''), last = Date.parse(end || '');
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null;
}
function attemptTiming(row, evidence) {
  const completed = evidence?.status === 'completed' && evidence.providerTaskId === row.provider_task_id;
  return {
    processingDurationMs: row.provider_id && completed ? providerDurationMs(evidence.processingDurationMs) : null,
    processingDurationSource: row.provider_id && completed && providerDurationMs(evidence.processingDurationMs) !== null ? 'provider_task_info' : null,
    submissionElapsedMs: row.provider_id ? elapsedMs(row.created_at, row.completed_at || row.updated_at) : null,
    localIngestionElapsedMs: !row.provider_id ? elapsedMs(row.started_at || row.created_at, row.ingested_at || row.completed_at || row.updated_at) : null,
  };
}
module.exports = { providerDurationMs, elapsedMs, attemptTiming };
