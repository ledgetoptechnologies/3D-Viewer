(function mouseNavigationProfilesModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsMouseNavigationProfiles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMouseNavigationProfiles() {
  const profiles = Object.freeze({
    default: Object.freeze({ id: 'default', label: 'Default (orbit-first)', buttons: Object.freeze({ 0: 'orbit', 1: 'screenpan', 2: 'pan' }) }),
    alternate: Object.freeze({ id: 'alternate', label: 'Alternate (pan-first)', buttons: Object.freeze({ 0: 'screenpan', 1: 'pan', 2: 'orbit' }) }),
  });
  function normalizeProfile(value) { return Object.hasOwn(profiles, value) ? value : 'default'; }
  function getProfile(value) { return profiles[normalizeProfile(value)]; }
  function actionForButton(profile, button) { return getProfile(profile).buttons[button] || 'none'; }
  return Object.freeze({ profiles, normalizeProfile, getProfile, actionForButton });
}));
