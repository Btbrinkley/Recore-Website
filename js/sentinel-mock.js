/**
 * Mock data provider for Sentinel Control Center
 * Provides realistic field-test data for development and demo purposes.
 */

const SentinelMockData = (() => {
  // Generate realistic mock readings centered around now, going back in time
  function generateHistory(hours) {
    const now = new Date();
    const readings = [];
    const intervalMs = (hours * 60 * 60 * 1000) / 48; // 48 readings over the period

    for (let i = 0; i < 48; i++) {
      const timestamp = new Date(now.getTime() - i * intervalMs);
      
      // Simulate natural voltage/temperature variation (battery discharged over time)
      const hourAgo = i;
      const voltageDecay = hourAgo * 0.02; // Lose ~0.02V per hour
      const tempVariation = Math.sin((hourAgo / 24) * Math.PI * 2) * 5; // ±5°F daily cycle

      readings.push({
        voltage: Math.max(10.5, 12.68 - voltageDecay + (Math.random() - 0.5) * 0.1),
        temperatureF: 98 + tempVariation + (Math.random() - 0.5) * 2,
        rssi: -85 + Math.floor(Math.random() * 10),
        status: 'OK',
        recordedAt: timestamp.toISOString(),
      });
    }

    return readings.reverse(); // Chronological order (oldest first)
  }

  return {
    getLatest(siteId, hubId, nodeId) {
      const now = new Date();
      return Promise.resolve({
        siteId,
        hubId,
        nodeId,
        latest: {
          voltage: 12.68,
          temperatureF: 101.3,
          rssi: -87,
          statusCode: 0,
          status: 'OK',
          sequence: Math.floor(Math.random() * 2000),
          recordedAt: new Date(now.getTime() - 45000).toISOString(), // 45 seconds ago
        },
      });
    },

    getNodes(siteId, hubId) {
      const now = new Date();
      return Promise.resolve({
        siteId,
        hubId,
        nodes: [
          {
            nodeId: 'node001',
            displayName: 'node001',
            assetName: null,
            lastSeenAt: new Date(now.getTime() - 45000).toISOString(),
            latest: {
              voltage: 12.68,
              temperatureF: 101.3,
              rssi: -87,
              statusCode: 0,
              status: 'OK',
              sequence: 1024,
              firmwareVersion: '0.4.1-field',
              recordedAt: new Date(now.getTime() - 45000).toISOString(),
            },
          },
        ],
      });
    },

    getHistory(siteId, hubId, nodeId, range) {
      let hours = 24;
      if (range === 'live') hours = 1;
      else if (range === '7d') hours = 168;
      else if (range === '30d') hours = 720;
      else if (range !== '24h') hours = 24; // default

      const readings = generateHistory(hours);

      return Promise.resolve({
        siteId,
        hubId,
        nodeId,
        range,
        readings,
      });
    },
  };
})();

// Export for use in Node.js test environments or strict module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SentinelMockData;
}
