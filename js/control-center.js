/**
 * Sentinel Control Center - Main Application Logic
 * 
 * Manages:
 * - Data fetching and refresh cycles
 * - Chart rendering
 * - UI state and error handling
 * - Range selection
 * - Online/offline determination
 */

(function() {
  'use strict';

  // ===== Constants =====
  const DEMO_IDS = {
    siteId: 'spitfire',
    hubId: 'hub001',
    nodeId: 'node001',
  };

  const STATE = {
    LOADING: 'loading',
    ERROR: 'error',
    NO_DATA: 'no-data',
    SUCCESS: 'success',
    API_UNAVAILABLE: 'api-unavailable',
    CONFIG_ERROR: 'config-error',
  };

  // ===== Application State =====
  let appState = {
    currentState: STATE.LOADING,
    latestData: null,
    historyData: null,
    selectedRange: '24h',
    chart: null,
    lastRefreshTime: null,
    refreshInterval: null,
    useMockData: false,
  };

  // ===== DOM Elements =====
  const el = {
    dataModeBadge: document.getElementById('dataModeBadge'),
    cloudStatus: document.getElementById('cloudStatus'),
    lastRefresh: document.getElementById('lastRefresh'),
    siteDisplay: document.getElementById('siteDisplay'),
    hubDisplay: document.getElementById('hubDisplay'),
    nodeDisplay: document.getElementById('nodeDisplay'),
    stateMessages: document.getElementById('stateMessages'),
    voltageValue: document.getElementById('voltageValue'),
    tempValue: document.getElementById('tempValue'),
    healthValue: document.getElementById('healthValue'),
    rssiValue: document.getElementById('rssiValue'),
    lastReportTime: document.getElementById('lastReportTime'),
    nodeStatusText: document.getElementById('nodeStatusText'),
    nodeOnlineStatus: document.getElementById('nodeOnlineStatus'),
    voltageStatus: document.getElementById('voltageStatus'),
    tempStatus: document.getElementById('tempStatus'),
    healthStatus: document.getElementById('healthStatus'),
    rssiStatus: document.getElementById('rssiStatus'),
    reportStatus: document.getElementById('reportStatus'),
    summaryMinVoltage: document.getElementById('summaryMinVoltage'),
    summaryMaxVoltage: document.getElementById('summaryMaxVoltage'),
    summaryMinTemp: document.getElementById('summaryMinTemp'),
    summaryMaxTemp: document.getElementById('summaryMaxTemp'),
    summaryCount: document.getElementById('summaryCount'),
    summaryRange: document.getElementById('summaryRange'),
    historyChart: document.getElementById('historyChart'),
    rangeButtons: document.querySelectorAll('.cc-range-btn'),
  };

  // ===== Utilities =====
  function formatTime(isoString) {
    try {
      const date = new Date(isoString);
      return date.toLocaleString();
    } catch {
      return '—';
    }
  }

  function formatTimeAgo(isoString) {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60000);
      const diffSec = Math.floor(diffMs / 1000);

      if (diffMin === 0) return `${diffSec}s ago`;
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return `${diffHrs}h ago`;
      const diffDays = Math.floor(diffHrs / 24);
      return `${diffDays}d ago`;
    } catch {
      return '—';
    }
  }

  function formatNumber(num, decimals = 2) {
    if (num === null || num === undefined) return '—';
    return Number(num).toFixed(decimals);
  }

  function showMessage(type, title, message) {
    const icon = {
      'error': '⚠️',
      'warning': '⚠️',
      'loading': '⏳',
      'info': 'ℹ️',
    }[type] || 'ℹ️';

    const messageHtml = `
      <div class="cc-state-message cc-state-${type}">
        <div class="cc-state-icon">${icon}</div>
        <div class="cc-state-text">
          <strong>${title}</strong><br>${message}
        </div>
      </div>
    `;

    el.stateMessages.innerHTML = messageHtml;
  }

  function clearMessages() {
    el.stateMessages.innerHTML = '';
  }

  // ===== Battery Health Assessment =====
  function assessBatteryHealth(voltage) {
    if (voltage === null || voltage === undefined) return 'Unknown';
    if (voltage >= 12.5) return 'Good';
    if (voltage >= 12.0) return 'Fair';
    if (voltage >= 11.0) return 'Low';
    return 'Critical';
  }

  // ===== UI Rendering =====
  function renderDeviceInfo() {
    el.siteDisplay.textContent = DEMO_IDS.siteId;
    el.hubDisplay.textContent = DEMO_IDS.hubId;
    el.nodeDisplay.textContent = DEMO_IDS.nodeId;
  }

  function renderDataModeAndConnection() {
    const config = window.SENTINEL_CONFIG;
    appState.useMockData = config.useMockData;

    if (config.useMockData) {
      el.dataModeBadge.textContent = 'DEMO DATA';
      el.dataModeBadge.className = 'cc-status-badge cc-status-demo';
      el.cloudStatus.textContent = 'Mock (Development)';
    } else {
      el.dataModeBadge.textContent = 'LIVE DATA';
      el.dataModeBadge.className = 'cc-status-badge cc-status-live';
      el.cloudStatus.textContent = config.apiUrl ? 'Connected' : 'Not Configured';
    }
  }

  function updateLastRefreshTime() {
    const now = new Date();
    appState.lastRefreshTime = now;
    el.lastRefresh.textContent = now.toLocaleTimeString();
  }

  function renderLatestData(data) {
    if (!data || !data.latest) return;

    const latest = data.latest;
    const isOnline = SentinelAPI.isNodeOnline(new Date(latest.recordedAt).getTime());

    // Voltage
    el.voltageValue.textContent = formatNumber(latest.voltage, 2);
    const voltageHealth = assessBatteryHealth(latest.voltage);

    // Temperature
    el.tempValue.textContent = formatNumber(latest.temperatureF, 1);

    // Health
    el.healthValue.textContent = voltageHealth;
    const healthColor = voltageHealth === 'Good' ? 'var(--good)' : 
                        voltageHealth === 'Fair' ? 'var(--testing)' :
                        '#d32f2f';
    el.healthStatus.innerHTML = `<div class="cc-metric-status-dot" style="background-color: ${healthColor}"></div>`;
    el.healthStatus.appendChild(document.createTextNode(voltageHealth));

    // RSSI
    el.rssiValue.textContent = latest.rssi || '—';

    // Last report time
    el.lastReportTime.textContent = formatTimeAgo(latest.recordedAt);

    // Node online/offline
    const statusClass = isOnline ? 'cc-metric-status-online' : 'cc-metric-status-offline';
    const statusText = isOnline ? 'Online' : 'Offline';
    el.nodeOnlineStatus.className = `cc-metric-status ${statusClass}`;
    el.nodeOnlineStatus.textContent = statusText;
    el.nodeStatusText.textContent = statusText;
  }

  function renderHistoryData(data) {
    if (!data || !data.readings || data.readings.length === 0) {
      el.summaryMinVoltage.textContent = '—';
      el.summaryMaxVoltage.textContent = '—';
      el.summaryMinTemp.textContent = '—';
      el.summaryMaxTemp.textContent = '—';
      el.summaryCount.textContent = '0';
      return;
    }

    const readings = data.readings;
    const voltages = readings.map(r => r.voltage).filter(v => v !== null && v !== undefined);
    const temps = readings.map(r => r.temperatureF).filter(t => t !== null && t !== undefined);

    const minVoltage = voltages.length > 0 ? Math.min(...voltages) : null;
    const maxVoltage = voltages.length > 0 ? Math.max(...voltages) : null;
    const minTemp = temps.length > 0 ? Math.min(...temps) : null;
    const maxTemp = temps.length > 0 ? Math.max(...temps) : null;

    el.summaryMinVoltage.textContent = minVoltage !== null ? formatNumber(minVoltage, 2) : '—';
    el.summaryMaxVoltage.textContent = maxVoltage !== null ? formatNumber(maxVoltage, 2) : '—';
    el.summaryMinTemp.textContent = minTemp !== null ? formatNumber(minTemp, 1) : '—';
    el.summaryMaxTemp.textContent = maxTemp !== null ? formatNumber(maxTemp, 1) : '—';
    el.summaryCount.textContent = readings.length;
    el.summaryRange.textContent = data.range || '—';
  }

  // ===== Chart Rendering =====
  function renderChart(data) {
    if (!data || !data.readings || data.readings.length === 0) {
      if (appState.chart) {
        appState.chart.destroy();
        appState.chart = null;
      }
      return;
    }

    const readings = data.readings;
    const labels = readings.map(r => new Date(r.recordedAt));
    const voltages = readings.map(r => r.voltage);
    const temperatures = readings.map(r => r.temperatureF);

    const ctx = el.historyChart.getContext('2d');

    // Destroy previous chart
    if (appState.chart) {
      appState.chart.destroy();
    }

    appState.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Voltage (V)',
            data: voltages,
            borderColor: 'var(--accent)',
            backgroundColor: 'rgba(242, 165, 48, 0.05)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointBackgroundColor: 'var(--accent)',
            tension: 0.1,
            yAxisID: 'y',
            fill: false,
          },
          {
            label: 'Temperature (°F)',
            data: temperatures,
            borderColor: 'var(--accent-2)',
            backgroundColor: 'rgba(91, 141, 201, 0.05)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointBackgroundColor: 'var(--accent-2)',
            tension: 0.1,
            yAxisID: 'y1',
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        animation: {
          duration: 0, // Disable animation for snappy updates
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: 'var(--text)',
              font: {
                size: 12,
                weight: '600',
              },
              padding: 12,
              usePointStyle: true,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(10, 15, 26, 0.9)',
            titleColor: 'var(--text)',
            bodyColor: 'var(--text-muted)',
            borderColor: 'var(--border)',
            borderWidth: 1,
            padding: 10,
            displayColors: true,
            callbacks: {
              title: function(context) {
                if (context.length > 0) {
                  return formatTime(context[0].label);
                }
                return '';
              },
              label: function(context) {
                let label = context.dataset.label || '';
                if (context.parsed.y !== null) {
                  const value = Number(context.parsed.y).toFixed(
                    context.dataset.yAxisID === 'y' ? 2 : 1
                  );
                  label += ': ' + value;
                }
                return label;
              },
            },
          },
        },
        scales: {
          x: {
            display: true,
            grid: {
              color: 'var(--border)',
            },
            ticks: {
              color: 'var(--text-muted)',
              font: { size: 11 },
            },
            type: 'time',
            time: {
              unit: 'hour',
              displayFormats: {
                hour: 'HH:mm',
                day: 'MMM DD',
              },
            },
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
              display: true,
              text: 'Voltage (V)',
              color: 'var(--accent)',
              font: { weight: 'bold' },
            },
            grid: {
              color: 'var(--border)',
            },
            ticks: {
              color: 'var(--text-muted)',
              font: { size: 11 },
            },
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: {
              display: true,
              text: 'Temperature (°F)',
              color: 'var(--accent-2)',
              font: { weight: 'bold' },
            },
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              color: 'var(--text-muted)',
              font: { size: 11 },
            },
          },
        },
      },
    });
  }

  // ===== Data Fetching =====
  async function fetchLatestData() {
    try {
      const data = await SentinelAPI.getLatest(DEMO_IDS.siteId, DEMO_IDS.hubId, DEMO_IDS.nodeId);
      appState.latestData = data;
      return data;
    } catch (error) {
      console.error('Failed to fetch latest data:', error);
      throw error;
    }
  }

  async function fetchHistoryData(range) {
    try {
      const data = await SentinelAPI.getHistory(DEMO_IDS.siteId, DEMO_IDS.hubId, DEMO_IDS.nodeId, range);
      appState.historyData = data;
      return data;
    } catch (error) {
      console.error(`Failed to fetch history for range ${range}:`, error);
      throw error;
    }
  }

  async function loadAllData(range) {
    clearMessages();
    appState.currentState = STATE.LOADING;
    showMessage('loading', 'Refreshing Data', 'Fetching latest readings and history...');

    try {
      const [latest, history] = await Promise.all([
        fetchLatestData(),
        fetchHistoryData(range),
      ]);

      renderLatestData(latest);
      renderHistoryData(history);
      renderChart(history);
      updateLastRefreshTime();
      appState.currentState = STATE.SUCCESS;
      clearMessages();
    } catch (error) {
      console.error('Error loading data:', error);

      if (appState.latestData || appState.historyData) {
        // We have cached data, show warning instead of error
        showMessage(
          'warning',
          'Data Refresh Failed',
          `Using cached data. Error: ${error.message}`
        );
        appState.currentState = STATE.ERROR;
      } else {
        // No cached data, show error
        const message = error.message.includes('not configured')
          ? 'API not configured. Set window.SENTINEL_CONFIG.apiUrl'
          : error.message;
        showMessage('error', 'Failed to Load Data', message);
        appState.currentState = STATE.ERROR;
      }
    }
  }

  // ===== Refresh Scheduling =====
  function startAutoRefresh() {
    if (appState.refreshInterval) {
      clearInterval(appState.refreshInterval);
    }

    appState.refreshInterval = setInterval(() => {
      if (document.hidden) {
        // Skip refresh if tab is hidden
        return;
      }
      loadAllData(appState.selectedRange);
    }, window.SENTINEL_CONFIG.liveRefreshIntervalMs);
  }

  function stopAutoRefresh() {
    if (appState.refreshInterval) {
      clearInterval(appState.refreshInterval);
      appState.refreshInterval = null;
    }
  }

  // ===== Range Selection =====
  function setupRangeButtons() {
    el.rangeButtons.forEach(btn => {
      btn.addEventListener('click', function() {
        const range = this.getAttribute('data-range');
        appState.selectedRange = range;

        el.rangeButtons.forEach(b => b.classList.remove('active'));
        this.classList.add('active');

        loadAllData(range);
      });
    });
  }

  // ===== Initialization =====
  function init() {
    try {
      // Validate configuration
      if (!window.SENTINEL_CONFIG) {
        showMessage(
          'error',
          'Configuration Error',
          'window.SENTINEL_CONFIG is not defined. Add config.js before control-center.js'
        );
        return;
      }

      renderDeviceInfo();
      renderDataModeAndConnection();
      setupRangeButtons();

      // Initial data load
      loadAllData(appState.selectedRange);

      // Start auto-refresh
      startAutoRefresh();

      // Handle visibility changes
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          stopAutoRefresh();
        } else {
          // Refresh immediately when tab becomes visible
          loadAllData(appState.selectedRange);
          startAutoRefresh();
        }
      });
    } catch (error) {
      console.error('Initialization error:', error);
      showMessage('error', 'Initialization Failed', error.message);
    }
  }

  // ===== Start when DOM is ready =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window.SentinelControlCenter = {
    getState: () => appState,
    refresh: () => loadAllData(appState.selectedRange),
    setMockMode: (use) => {
      window.SENTINEL_CONFIG.useMockData = use;
      location.reload();
    },
  };
})();
