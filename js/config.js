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
    // API base URL (must include protocol and domain, no trailing slash)
    // Example: https://api.recore.example.com/v1
    apiUrl: injected.apiUrl || '',

    // Enable mock data for development/demo
    useMockData: injected.useMockData === 'true' || injected.useMockData === true,

    // Online timeout: consider node offline if no reading in this many milliseconds
    onlineTimeoutMs: injected.onlineTimeoutMs || 300000, // 5 minutes

    // Refresh interval for live data (milliseconds)
    liveRefreshIntervalMs: injected.liveRefreshIntervalMs || 30000, // 30 seconds

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
