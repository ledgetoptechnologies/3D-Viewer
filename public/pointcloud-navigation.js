(function pointCloudNavigationModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudNavigation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudNavigation() {
  const POINT_PICK_WINDOW = 11;

  function isPlausibleAnchorDistance(hitDistance, referenceDistance) {
    if (!Number.isFinite(hitDistance) || !Number.isFinite(referenceDistance)
      || hitDistance < 0 || referenceDistance <= 0) return false;
    const behindAllowance = Math.max(5, referenceDistance * 0.35);
    return hitDistance <= referenceDistance + behindAllowance;
  }

  return Object.freeze({ POINT_PICK_WINDOW, isPlausibleAnchorDistance });
}));
