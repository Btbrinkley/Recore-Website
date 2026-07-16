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

  const AXIS_2DP_FORMATTER = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const AXIS_1DP_FORMATTER = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

  const TOOLTIP_SHORT_DATE_TIME = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const TOOLTIP_LONG_DATE_TIME = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  // ===== Application State =====
  let appState = {
    currentState: STATE.LOADING,
    latestData: null,
    historyData: null,
    selectedRange: '24h',
    selectedNodeId: DEMO_IDS.nodeId,
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

  function getTooltipTimestamp(contextPoint) {
    if (!contextPoint) return null;
    if (Number.isFinite(contextPoint.parsed && contextPoint.parsed.x)) {
      return contextPoint.parsed.x;
    }
    const raw = contextPoint.raw;
    if (raw && typeof raw === 'object') {
      if (raw.x !== null && raw.x !== undefined) return raw.x;
      if (raw.recordedAt) return raw.recordedAt;
    }
    return null;
  }

  function formatTooltipTitle(tooltipItems, range) {
    if (!tooltipItems || tooltipItems.length === 0) return '';
    const timestamp = getTooltipTimestamp(tooltipItems[0]);
    const date = toDate(timestamp);
    if (!date) {
      if (tooltipItems[0].raw && tooltipItems[0].raw.recordedAt) {
        return tooltipItems[0].raw.recordedAt;
      }
      return 'Timestamp unavailable';
    }
    const formatter = range === '7d' || range === '30d'
      ? TOOLTIP_LONG_DATE_TIME
      : TOOLTIP_SHORT_DATE_TIME;
    return formatter.format(date);
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

  function percentile(sortedValues, p) {
    if (!sortedValues.length) return null;
    const index = (sortedValues.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
  }

  function calculateAxisBounds(values, options) {
    const settings = Object.assign({
      robust: false,
      paddingRatio: 0.1,
      minPadding: 0.1,
      minSpan: 0.25,
    }, options || {});

    const clean = values.filter((value) => Number.isFinite(value));
    if (!clean.length) {
      return {
        hasData: false,
        min: undefined,
        max: undefined,
        outlierCount: 0,
      };
    }

    const sorted = clean.slice().sort((a, b) => a - b);
    const actualMin = sorted[0];
    const actualMax = sorted[sorted.length - 1];
    let focusMin = actualMin;
    let focusMax = actualMax;
    let outlierCount = 0;

    if (settings.robust && sorted.length >= 6) {
      const q1 = percentile(sorted, 0.25);
      const q3 = percentile(sorted, 0.75);
      const iqr = q3 - q1;
      if (Number.isFinite(iqr) && iqr > 0) {
        const lowFence = q1 - (1.5 * iqr);
        const highFence = q3 + (1.5 * iqr);
        const inliers = sorted.filter((value) => value >= lowFence && value <= highFence);
        outlierCount = sorted.length - inliers.length;
        if (inliers.length >= 3) {
          focusMin = inliers[0];
          focusMax = inliers[inliers.length - 1];
        }
      }
    }

    let span = focusMax - focusMin;
    if (!Number.isFinite(span) || span < settings.minSpan) {
      span = settings.minSpan;
      const center = (focusMin + focusMax) / 2;
      focusMin = center - (span / 2);
      focusMax = center + (span / 2);
    }

    const pad = Math.max(settings.minPadding, span * settings.paddingRatio);
    return {
      hasData: true,
      min: focusMin - pad,
      max: focusMax + pad,
      outlierCount,
      actualMin,
      actualMax,
    };
  }

  function getTimeScaleConfig(range, readings) {
    const safeRange = range || '24h';
    const dates = readings
      .map((reading) => toDate(reading.recordedAt))
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());

    const spanMs = dates.length > 1
      ? dates[dates.length - 1].getTime() - dates[0].getTime()
      : 0;

    const configByRange = {
      live: {
        unit: spanMs <= 6 * 60 * 60 * 1000 ? 'minute' : 'hour',
        maxTicksLimit: 8,
      },
      '24h': {
        unit: 'hour',
        maxTicksLimit: 8,
      },
      '7d': {
        unit: 'day',
        maxTicksLimit: 8,
      },
      '30d': {
        unit: 'day',
        maxTicksLimit: 10,
      },
    };

    const chosen = configByRange[safeRange] || configByRange['24h'];

    return {
      unit: chosen.unit,
      maxTicksLimit: chosen.maxTicksLimit,
      displayFormats: {
        minute: 'h:mm a',
        hour: safeRange === '24h' || safeRange === 'live' ? 'h a' : 'MMM d, h a',
        day: 'MMM d',
      },
    };
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
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No nodes found';
      el.nodeSelect.appendChild(opt);
      return;
    }

    nodes.forEach((node) => {
      const opt = document.createElement('option');
      opt.value = node.nodeId;
      opt.textContent = node.displayName || node.nodeId;
      if (node.nodeId === appState.selectedNodeId) opt.selected = true;
      el.nodeSelect.appendChild(opt);
    });

    // If the previously selected node is no longer in the list, default to first
    const inList = nodes.some((n) => n.nodeId === appState.selectedNodeId);
    if (!inList) {
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
    el.tempValue.textContent = formatTemperature(latest.temperatureF);

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
    const temps = readings.map((reading) => reading.temperatureF).filter((value) => value !== null && value !== undefined);

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

  // ===== Chart Visual Plugins =====
  // Draws a thin vertical guide line through the active hover point,
  // similar to a cursor readout on lab/telemetry instruments.
  const verticalHoverLinePlugin = {
    id: 'verticalHoverLine',
    afterDatasetsDraw(chart) {
      const active = chart.getActiveElements();
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(231, 235, 243, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    },
  };

  // ===== Chart Rendering =====
  function renderChart(data, selectedRange) {
    const readings = (data && Array.isArray(data.readings)) ? data.readings : [];
    if (!readings.length) {
      showChartNotice('');
      if (appState.chart) {
        appState.chart.destroy();
        appState.chart = null;
      }
      return;
    }

    const sortedReadings = readings
      .slice()
      .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());

    const voltagePoints = sortedReadings.map((reading) => ({
      x: new Date(reading.recordedAt).getTime(),
      y: reading.voltage,
      recordedAt: reading.recordedAt,
    }));

    const temperaturePoints = sortedReadings.map((reading) => ({
      x: new Date(reading.recordedAt).getTime(),
      y: reading.temperatureF === undefined ? null : reading.temperatureF,
      recordedAt: reading.recordedAt,
    }));

    const voltageValues = readings
      .map((reading) => reading.voltage)
      .filter((value) => Number.isFinite(value));
    const temperatureValues = readings
      .map((reading) => reading.temperatureF)
      .filter((value) => Number.isFinite(value));

    const voltageBounds = calculateAxisBounds(voltageValues, {
      robust: true,
      paddingRatio: 0.12,
      minPadding: 0.05,
      minSpan: 0.2,
    });
    const temperatureBounds = calculateAxisBounds(temperatureValues, {
      robust: false,
      paddingRatio: 0.15,
      minPadding: 1,
      minSpan: 3,
    });

    if (voltageBounds.outlierCount > 0) {
      showChartNotice(
        `Voltage scale is focused on typical readings; ${voltageBounds.outlierCount} outlier reading` +
        `${voltageBounds.outlierCount === 1 ? '' : 's'} remain visible outside the focused trend range.`
      );
    } else {
      showChartNotice('');
    }

    const rangeForChart = selectedRange || (data && data.range) || appState.selectedRange;
    const timeScale = getTimeScaleConfig(rangeForChart, sortedReadings);
    const shouldDecimate = (rangeForChart === '7d' || rangeForChart === '30d') && sortedReadings.length > 800;

    const ctx = el.historyChart.getContext('2d');
    if (appState.chart) {
      appState.chart.destroy();
    }

    appState.chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Voltage (V)',
            data: voltagePoints,
            parsing: false,
            borderColor: '#f2a530',
            backgroundColor: 'rgba(242, 165, 48, 0.08)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHitRadius: 12,
            pointBackgroundColor: '#f2a530',
            pointHoverBackgroundColor: '#f2a530',
            pointHoverBorderColor: '#0a0f1a',
            pointHoverBorderWidth: 2,
            tension: 0,
            yAxisID: 'y',
            fill: false,
          },
          {
            label: 'Temperature (°F)',
            data: temperaturePoints,
            parsing: false,
            borderColor: '#5b8dc9',
            backgroundColor: 'rgba(91, 141, 201, 0.08)',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHitRadius: 12,
            pointBackgroundColor: '#5b8dc9',
            pointHoverBackgroundColor: '#5b8dc9',
            pointHoverBorderColor: '#0a0f1a',
            pointHoverBorderWidth: 2,
            tension: 0,
            yAxisID: 'y1',
            fill: false,
            spanGaps: false,
          },
        ],
      },
      plugins: [verticalHoverLinePlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        normalized: true,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        hover: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          decimation: {
            enabled: shouldDecimate,
            algorithm: 'lttb',
            threshold: 900,
            samples: rangeForChart === '30d' ? 550 : 700,
          },
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: '#e7ebf3',
              font: {
                size: 12,
                weight: '600',
              },
              padding: 16,
              usePointStyle: true,
              pointStyle: 'line',
              boxWidth: 24,
            },
          },
          tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(10, 15, 26, 0.95)',
            titleColor: '#e7ebf3',
            bodyColor: '#93a3bf',
            borderColor: '#25334d',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 6,
            displayColors: true,
            usePointStyle: true,
            boxPadding: 4,
            titleFont: { size: 12, weight: '700' },
            bodyFont: { size: 12 },
            callbacks: {
              title(context) {
                return formatTooltipTitle(context, rangeForChart);
              },
              label(context) {
                const datasetLabel = context.dataset && context.dataset.label ? context.dataset.label : '';
                const value = context.parsed.y;
                if (value === null || value === undefined) return `${datasetLabel}: —`;
                if (datasetLabel.includes('Voltage')) {
                  return `${datasetLabel}: ${formatVoltage(value)} V`;
                }
                if (datasetLabel.includes('Temperature')) {
                  return `${datasetLabel}: ${formatTemperature(value)} °F`;
                }
                return `${datasetLabel}: ${value}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            display: true,
            time: {
              unit: timeScale.unit,
              displayFormats: timeScale.displayFormats,
            },
            grid: {
              color: 'rgba(147, 163, 191, 0.08)',
              tickColor: 'rgba(147, 163, 191, 0.2)',
            },
            border: {
              color: 'rgba(147, 163, 191, 0.25)',
            },
            ticks: {
              color: '#93a3bf',
              font: { size: 11, family: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: timeScale.maxTicksLimit,
            },
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: voltageBounds.hasData ? voltageBounds.min : undefined,
            max: voltageBounds.hasData ? voltageBounds.max : undefined,
            title: {
              display: true,
              text: 'Voltage (V)',
              color: '#f2a530',
              font: { weight: 'bold', size: 12 },
            },
            grid: {
              color: 'rgba(147, 163, 191, 0.08)',
            },
            border: {
              color: 'rgba(147, 163, 191, 0.25)',
            },
            ticks: {
              color: '#93a3bf',
              font: { size: 11, family: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
              callback(value) {
                return AXIS_2DP_FORMATTER.format(Number(value));
              },
            },
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            min: temperatureBounds.hasData ? temperatureBounds.min : undefined,
            max: temperatureBounds.hasData ? temperatureBounds.max : undefined,
            title: {
              display: true,
              text: 'Temperature (°F)',
              color: '#5b8dc9',
              font: { weight: 'bold', size: 12 },
            },
            grid: {
              drawOnChartArea: false,
            },
            border: {
              color: 'rgba(147, 163, 191, 0.25)',
            },
            ticks: {
              color: '#93a3bf',
              font: { size: 11, family: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
              callback(value) {
                return AXIS_1DP_FORMATTER.format(Number(value));
              },
            },
          },
        },
      },
    });
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
        appState.availableNodes = nodesData.nodes || [];
      } catch (error) {
        // Fall back to the hardcoded node so the page still works
        appState.availableNodes = [{ nodeId: DEMO_IDS.nodeId, displayName: DEMO_IDS.nodeId, assetName: null }];
        console.warn('[Sentinel] Node discovery failed, using fallback node:', error.message);
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
