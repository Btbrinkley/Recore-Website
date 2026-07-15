/**
 * Sentinel Control Center Configuration
 * 
 * Environment variables:
 * - PUBLIC_SENTINEL_API_URL: Base URL for the read-only Sentinel API
 * - PUBLIC_SENTINEL_USE_MOCK_DATA: Set to "true" to use mock data instead of live API
 * 
 * This file reads from window.SENTINEL_CONFIG (injected at runtime) or falls back to defaults.
 */

(function() {
  // Read from window.SENTINEL_CONFIG if injected, otherwise use defaults
  const injected = window.SENTINEL_CONFIG || {};

  window.SENTINEL_CONFIG = {
  apiUrl: 'https://us-central1-sentinel-74f28.cloudfunctions.net',
  useMockData: false,
  onlineTimeoutMs: 300000,
  liveRefreshIntervalMs: 30000,

    // Default field-test identifiers
    defaultSiteId: 'spitfire',
    defaultHubId: 'hub001',
    defaultNodeId: 'node001',
  };

  console.log('[Sentinel Config] Loaded:', {
    apiUrl: window.SENTINEL_CONFIG.apiUrl || '(empty)',
    useMockData: window.SENTINEL_CONFIG.useMockData,
  });
})();
