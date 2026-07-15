/**
 * Sentinel API Service
 * 
 * Centralized service for Sentinel telemetry data.
 * Fetches from live API or mock data based on configuration.
 * 
 * Configuration (window.SENTINEL_CONFIG):
 * - apiUrl: Base URL for live API (e.g., "https://api.example.com/v1")
 * - useMockData: Boolean, use SentinelMockData if true
 * - onlineTimeoutMs: Timeout for considering node offline
 * 
 * Usage:
 *   SentinelAPI.getLatest('spitfire', 'hub001', 'node001')
 *     .then(response => console.log(response))
 *     .catch(error => console.error(error));
 * 
 *   SentinelAPI.getHistory('spitfire', 'hub001', 'node001', '24h')
 *     .then(response => console.log(response))
 *     .catch(error => console.error(error));
 */

const SentinelAPI = (() => {
  // Validate configuration on first use
  function getConfig() {
    if (!window.SENTINEL_CONFIG) {
      throw new Error('SENTINEL_CONFIG not initialized. Include config.js before sentinel-api.js');
    }
    return window.SENTINEL_CONFIG;
  }

  /**
   * Fetch from live API endpoint
   * @private
   */
  async function fetchLive(endpoint, params) {
    const config = getConfig();

    if (!config.apiUrl) {
      throw new Error(
        'PUBLIC_SENTINEL_API_URL not configured. Set window.SENTINEL_CONFIG.apiUrl before using live API.'
      );
    }

    // Build URL with query parameters using URLSearchParams
    const url = new URL(config.apiUrl + endpoint);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(
        `API error ${response.status}: ${response.statusText} (${url.toString()})`
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error(`Invalid JSON response from ${url.toString()}: ${e.message}`);
    }

    return data;
  }

  /**
   * Validate latest response structure
   * Accepts null or undefined for temperatureF
   * @private
   */
  function validateLatestResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Latest response is not an object');
    }

    if (!data.latest || typeof data.latest !== 'object') {
      throw new Error('Response missing "latest" field');
    }

    const validVoltage =
      typeof data.latest.voltage === 'number' &&
      Number.isFinite(data.latest.voltage);

    const validTemperature =
      data.latest.temperatureF === null ||
      data.latest.temperatureF === undefined ||
      (
        typeof data.latest.temperatureF === 'number' &&
        Number.isFinite(data.latest.temperatureF)
      );

    const validTimestamp =
      typeof data.latest.recordedAt === 'string' &&
      !Number.isNaN(Date.parse(data.latest.recordedAt));

    if (!validVoltage || !validTemperature || !validTimestamp) {
      throw new Error('Latest response missing required fields');
    }

    return data;
  }

  /**
   * Validate and sanitize history response structure
   * Accepts null or undefined for temperatureF in readings
   * Filters out invalid readings rather than rejecting the entire response
   * @private
   */
  function validateHistoryResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('History response is not an object');
    }

    if (!Array.isArray(data.readings)) {
      throw new Error('Response missing "readings" array');
    }

    data.readings = data.readings.filter((reading, i) => {
      const validVoltage =
        typeof reading.voltage === 'number' &&
        Number.isFinite(reading.voltage);

      const validTemperature =
        reading.temperatureF === null ||
        reading.temperatureF === undefined ||
        (
          typeof reading.temperatureF === 'number' &&
          Number.isFinite(reading.temperatureF)
        );

      const validTimestamp =
        typeof reading.recordedAt === 'string' &&
        !Number.isNaN(Date.parse(reading.recordedAt));

      if (!validVoltage || !validTemperature || !validTimestamp) {
        console.warn(
          `[Sentinel API] Skipping malformed history reading ${i}`,
          reading
        );
        return false;
      }

      return true;
    });

    return data;
  }

  return {
    /**
     * Fetch latest reading for a node
     * @param {string} siteId
     * @param {string} hubId
     * @param {string} nodeId
     * @returns {Promise} Resolves with { siteId, hubId, nodeId, latest: {...} }
     */
    async getLatest(siteId, hubId, nodeId) {
      const config = getConfig();

      if (config.useMockData) {
        return SentinelMockData.getLatest(siteId, hubId, nodeId);
      }

      try {
        const data = await fetchLive('/dashboard/latest', {
          siteId,
          hubId,
          nodeId,
        });
        return validateLatestResponse(data);
      } catch (error) {
        throw new Error(`Failed to fetch latest: ${error.message}`);
      }
    },

    /**
     * Fetch historical readings for a node
     * @param {string} siteId
     * @param {string} hubId
     * @param {string} nodeId
     * @param {string} range One of: live, 24h, 7d, 30d
     * @returns {Promise} Resolves with { siteId, hubId, nodeId, range, readings: [...] }
     */
    async getHistory(siteId, hubId, nodeId, range) {
      const config = getConfig();

      const validRanges = ['live', '24h', '7d', '30d'];
      if (!validRanges.includes(range)) {
        throw new Error(`Invalid range "${range}". Supported: ${validRanges.join(', ')}`);
      }

      if (config.useMockData) {
        return SentinelMockData.getHistory(siteId, hubId, nodeId, range);
      }

      try {
        const data = await fetchLive('/dashboard/history', {
          siteId,
          hubId,
          nodeId,
          range,
        });
        return validateHistoryResponse(data);
      } catch (error) {
        throw new Error(`Failed to fetch history for range "${range}": ${error.message}`);
      }
    },

    /**
     * Determine if node is online based on latest reading timestamp
     * @param {number} latestReadingMs Timestamp of latest reading in milliseconds
     * @returns {boolean}
     */
    isNodeOnline(latestReadingMs) {
      const config = getConfig();
      const now = Date.now();
      return now - latestReadingMs < config.onlineTimeoutMs;
    },
  };
})();

// Export for Node.js test environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SentinelAPI;
}
