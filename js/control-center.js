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
  // Site/hub come from config.js (URL override -> injected -> live default),
  // so the dashboard tracks whatever Site ID / Hub name the hub is set to.
  const DEMO_IDS = {
    siteId: (window.SENTINEL_CONFIG && window.SENTINEL_CONFIG.defaultSiteId) || 'site001',
    hubId: (window.SENTINEL_CONFIG && window.SENTINEL_CONFIG.defaultHubId) || 'Home',
  };

  const RANGE_LABELS = {
    live: 'Live',
    '24h': '24 Hours',
    '7d': '7 Days',
    '30d': '30 Days',
  };

  const STATE = {
    LOADING: 'loading',
    ERROR: 'error',
    NO_DATA: 'no-data',
    SUCCESS: 'success',
    API_UNAVAILABLE: 'api-unavailable',
    CONFIG_ERROR: 'config-error',
  };

  const VOLTAGE_FORMATTER = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });

  const TEMPERATURE_FORMATTER = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const INTEGER_FORMATTER = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  });

  // ===== Application State =====
  let appState = {
    currentState: STATE.LOADING,
    latestData: null,
    historyData: null,
    selectedRange: '24h',
    selectedNodeId: null,
    availableNodes: [],
    chart: null,
    lastRefreshTime: null,
    refreshInterval: null,
    useMockData: false,
    requestCounter: 0,
    activeRequestId: 0,
  };

  // ===== DOM Elements =====
  const el = {
    dataModeBadge: document.getElementById('dataModeBadge'),
    cloudStatus: document.getElementById('cloudStatus'),
    lastRefresh: document.getElementById('lastRefresh'),
    siteDisplay: document.getElementById('siteDisplay'),
    hubDisplay: document.getElementById('hubDisplay'),
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
    chartOutlierNotice: document.getElementById('chartOutlierNotice'),
    nodeSelect: document.getElementById('nodeSelect'),
  };

  // ===== Utilities =====
  function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function getRangeLabel(range) {
    return RANGE_LABELS[range] || range || '—';
  }

  function formatVoltage(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return VOLTAGE_FORMATTER.format(Number(value));
  }

  function formatTemperature(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return TEMPERATURE_FORMATTER.format(Number(value));
  }

  function formatInteger(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return INTEGER_FORMATTER.format(Number(value));
  }

  function formatTimeAgo(isoString) {
    const date = toDate(isoString);
    if (!date) return '—';

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
  }

  function setRangeButtonState(activeRange, loading) {
    el.rangeButtons.forEach((button) => {
      const range = button.getAttribute('data-range');
      const isActive = range === activeRange;
      button.classList.toggle('active', isActive);
      button.classList.toggle('is-loading', isActive && loading);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.setAttribute('aria-busy', isActive && loading ? 'true' : 'false');
    });
  }

  function showChartNotice(message) {
    if (!el.chartOutlierNotice) return;
    if (!message) {
      el.chartOutlierNotice.textContent = '';
      el.chartOutlierNotice.hidden = true;
      return;
    }
    el.chartOutlierNotice.textContent = message;
    el.chartOutlierNotice.hidden = false;
  }

  function showMessage(type, title, message) {
    const icon = {
      error: '⚠️',
      warning: '⚠️',
      loading: '⏳',
      info: 'ℹ️',
    }[type] || 'ℹ️';

    el.stateMessages.innerHTML = `
      <div class="cc-state-message cc-state-${type}">
        <div class="cc-state-icon">${icon}</div>
        <div class="cc-state-text">
          <strong>${title}</strong><br>${message}
        </div>
      </div>
    `;
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
  }

  function renderNodeSelector(nodes) {
    if (!el.nodeSelect) return;
    el.nodeSelect.innerHTML = '';

    if (!nodes || !nodes.length) {
      appState.selectedNodeId = null;
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = 'No nodes found';
      el.nodeSelect.appendChild(opt);
      return;
    }

    nodes.forEach((node) => {
      const opt = document.createElement('option');
      opt.value = node.nodeId;
      // "DisplayName — nodeId" when a distinct display name is present, else just nodeId
      const hasName = node.displayName && node.displayName !== node.nodeId;
      opt.textContent = hasName ? node.displayName : node.nodeId;
      el.nodeSelect.appendChild(opt);
    });

    // Keep the currently selected node if it is still in the list.
    // Otherwise fall through to first node (API is the source of truth for ordering).
    const stillPresent = appState.selectedNodeId &&
      nodes.some((n) => n.nodeId === appState.selectedNodeId);
    if (stillPresent) {
      el.nodeSelect.value = appState.selectedNodeId;
    } else {
      appState.selectedNodeId = nodes[0].nodeId;
      el.nodeSelect.value = appState.selectedNodeId;
    }
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
    const latestTimestamp = toDate(latest.recordedAt);
    const isOnline = latestTimestamp
      ? SentinelAPI.isNodeOnline(latestTimestamp.getTime())
      : false;

    // Voltage
    el.voltageValue.textContent = formatVoltage(latest.voltage);
    const voltageHealth = assessBatteryHealth(latest.voltage);

    // Temperature
    el.tempValue.textContent = formatTemperature(latest.externalTemperatureF);
    if (el.tempStatus) el.tempStatus.textContent = Number.isFinite(latest.externalTemperatureF)
      ? 'External probe' : latest.externalTempStatus === 2 ? 'Probe fault' : latest.externalTempStatus === 0 ? 'Probe not detected' : 'No external reading uploaded';
    const internal = latest.internalTemperatureF === undefined ? latest.temperatureF : latest.internalTemperatureF;
    const onboard = document.getElementById('onboardTempMetric');
    onboard.hidden = !Number.isFinite(internal);
    document.getElementById('onboardTempValue').textContent = formatTemperature(internal);

    // Health
    el.healthValue.textContent = voltageHealth;
    const healthColor = voltageHealth === 'Good'
      ? 'var(--good)'
      : voltageHealth === 'Fair'
        ? 'var(--testing)'
        : '#d32f2f';
    el.healthStatus.innerHTML = `<div class="cc-metric-status-dot" style="background-color: ${healthColor}"></div>`;
    el.healthStatus.appendChild(document.createTextNode(voltageHealth));

    // RSSI
    el.rssiValue.textContent = formatInteger(latest.rssi);

    // Last report time
    el.lastReportTime.textContent = formatTimeAgo(latest.recordedAt);

    // Node online/offline
    const statusClass = isOnline ? 'cc-metric-status-online' : 'cc-metric-status-offline';
    const statusText = isOnline ? 'Online' : 'Offline';
    el.nodeOnlineStatus.className = `cc-metric-status ${statusClass}`;
    el.nodeOnlineStatus.textContent = statusText;
    el.nodeStatusText.textContent = statusText;
  }

  function renderHistoryData(data, selectedRange) {
    const readings = (data && Array.isArray(data.readings)) ? data.readings : [];
    const rangeLabel = getRangeLabel((data && data.range) || selectedRange);

    if (!readings.length) {
      el.summaryMinVoltage.textContent = '—';
      el.summaryMaxVoltage.textContent = '—';
      el.summaryMinTemp.textContent = '—';
      el.summaryMaxTemp.textContent = '—';
      el.summaryCount.textContent = '0';
      el.summaryRange.textContent = rangeLabel;
      return;
    }

    const voltages = readings.map((reading) => reading.voltage).filter((value) => value !== null && value !== undefined);
    const temps = readings.flatMap((reading) => [reading.internalTemperatureF === undefined ? reading.temperatureF : reading.internalTemperatureF, reading.externalTemperatureF]).filter((value) => value !== null && value !== undefined);

    const minVoltage = voltages.length > 0 ? Math.min(...voltages) : null;
    const maxVoltage = voltages.length > 0 ? Math.max(...voltages) : null;
    const minTemp = temps.length > 0 ? Math.min(...temps) : null;
    const maxTemp = temps.length > 0 ? Math.max(...temps) : null;

    el.summaryMinVoltage.textContent = minVoltage !== null ? formatVoltage(minVoltage) : '—';
    el.summaryMaxVoltage.textContent = maxVoltage !== null ? formatVoltage(maxVoltage) : '—';
    el.summaryMinTemp.textContent = minTemp !== null ? formatTemperature(minTemp) : '—';
    el.summaryMaxTemp.textContent = maxTemp !== null ? formatTemperature(maxTemp) : '—';
    el.summaryCount.textContent = formatInteger(readings.length);
    el.summaryRange.textContent = rangeLabel;
  }

  // Same sample-by-sample SVG chart as the local Hub control center.
  function renderChart(data) {
    const readings = data && Array.isArray(data.readings) ? data.readings : [];
    SentinelChart.render(el.historyChart, readings, appState.selectedNodeId + ':' + appState.selectedRange);
    showChartNotice(data && data.truncated
      ? `Showing the newest ${data.limit} readings in this range. Select a shorter range for more detail.` : '');
  }

  // ===== Data Fetching =====
  async function fetchNodes() {
    try {
      return await SentinelAPI.getNodes(DEMO_IDS.siteId, DEMO_IDS.hubId);
    } catch (error) {
      console.error('Failed to fetch nodes:', error);
      throw error;
    }
  }

  async function fetchLatestData() {
    try {
      return await SentinelAPI.getLatest(DEMO_IDS.siteId, DEMO_IDS.hubId, appState.selectedNodeId);
    } catch (error) {
      console.error('Failed to fetch latest data:', error);
      throw error;
    }
  }

  async function fetchHistoryData(range) {
    try {
      return await SentinelAPI.getHistory(DEMO_IDS.siteId, DEMO_IDS.hubId, appState.selectedNodeId, range);
    } catch (error) {
      console.error(`Failed to fetch history for range ${range}:`, error);
      throw error;
    }
  }

  async function loadAllData(range) {
    const requestedRange = range || appState.selectedRange;
    appState.selectedRange = requestedRange;

    if (!appState.selectedNodeId) {
      showMessage('error', 'No Node Selected', 'No monitoring node is available. Check the hub connection and reload the page.');
      return;
    }

    const requestId = ++appState.requestCounter;
    appState.activeRequestId = requestId;

    setRangeButtonState(requestedRange, true);
    clearMessages();
    appState.currentState = STATE.LOADING;
    showMessage('loading', 'Refreshing Data', `Fetching latest readings and ${getRangeLabel(requestedRange)} history...`);

    try {
      const [latest, history] = await Promise.all([
        fetchLatestData(),
        fetchHistoryData(requestedRange),
      ]);

      if (requestId !== appState.activeRequestId) {
        console.info(`[Sentinel Control Center] Ignored stale response for range "${requestedRange}"`);
        return;
      }

      appState.latestData = latest;
      appState.historyData = history;

      renderLatestData(latest);
      renderHistoryData(history, requestedRange);
      renderChart(history, requestedRange);
      updateLastRefreshTime();

      const hasReadings = history && Array.isArray(history.readings) && history.readings.length > 0;
      if (hasReadings) {
        appState.currentState = STATE.SUCCESS;
        clearMessages();
      } else {
        appState.currentState = STATE.NO_DATA;
        showMessage(
          'info',
          'No Readings in Selected Range',
          `The API returned no historical readings for ${getRangeLabel(requestedRange)}.`
        );
      }
    } catch (error) {
      if (requestId !== appState.activeRequestId) {
        console.info(`[Sentinel Control Center] Ignored stale request error for range "${requestedRange}"`);
        return;
      }

      console.error('Error loading data:', error);
      const hasCachedData = appState.latestData || appState.historyData;

      if (hasCachedData) {
        showMessage(
          'warning',
          'Data Refresh Failed',
          `Using cached ${getRangeLabel(appState.selectedRange)} data. Error: ${error.message}`
        );
        appState.currentState = STATE.ERROR;
      } else {
        const message = error.message.includes('not configured')
          ? 'API not configured. Set window.SENTINEL_CONFIG.apiUrl'
          : error.message;
        showMessage('error', 'Failed to Load Data', message);
        appState.currentState = STATE.ERROR;
      }
    } finally {
      if (requestId === appState.activeRequestId) {
        setRangeButtonState(requestedRange, false);
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
    setRangeButtonState(appState.selectedRange, false);
    el.rangeButtons.forEach((button) => {
      button.addEventListener('click', function() {
        const range = this.getAttribute('data-range');
        loadAllData(range);
      });
    });
  }

  // ===== Initialization =====
  async function init() {
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

      // Discover nodes before loading telemetry
      showMessage('loading', 'Connecting', 'Discovering nodes…');
      try {
        const nodesData = await fetchNodes();
        const freshNodes = (nodesData && Array.isArray(nodesData.nodes)) ? nodesData.nodes : [];
        if (freshNodes.length) {
          // Update the known list only when the API returns something useful,
          // so a transient failure never wipes out the last good list.
          appState.availableNodes = freshNodes;
        }
      } catch (error) {
        console.error('[Sentinel] Node discovery failed:', error.message);
        // Keep whatever was in availableNodes (empty on first load).
      }

      if (!appState.availableNodes.length) {
        showMessage(
          'error',
          'No Nodes Discovered',
          'No monitoring nodes were found for this hub. Check that the hub is reporting and reload the page.'
        );
        return;
      }

      renderNodeSelector(appState.availableNodes);

      // Switch node when user changes the selector
      if (el.nodeSelect) {
        el.nodeSelect.addEventListener('change', function() {
          appState.selectedNodeId = this.value;
          loadAllData(appState.selectedRange);
        });
      }

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
