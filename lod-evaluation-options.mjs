// Explicit per-page A/B switches. No persistence and no automatic device-based
// activation: a normal Viewer session retains the evaluated baseline policy.
export function lodEvaluationOptions(search = '') {
  const query = new URLSearchParams(search);
  return Object.freeze({
    distanceDemand: query.get('lodDistanceDemand') === '1',
    loadingTiming: query.get('lodLoadingTiming') === '1',
  });
}

export function formatJsHeap(bytes) {
  return Number.isFinite(bytes) && bytes >= 0
    ? `JS heap: ${Math.round(bytes / 1048576)} MiB`
    : 'JS heap: unavailable';
}
