// This service worker is required for Manifest V3 extensions.
// It currently has no active role but is necessary for the extension to load.
chrome.runtime.onInstalled.addListener(() => {
  console.log('AirPlay Screen Caster extension installed.');
});