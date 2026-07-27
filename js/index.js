"use strict";
const crypto = require("crypto");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const {initializeApp} = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");
initializeApp();
const db = getFirestore();
const ingestKey = defineSecret("SENTINEL_INGEST_KEY");
const REGION = "us-central1";
const MAX_BODY_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function sendJson(res, status, body) {
  res.status(status).set("Cache-Control", "no-store").json(body);
}
function safeEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") {
    return false;
  }
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
function requiredId(value, fieldName) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${fieldName} must be 1-64 letters, numbers, hyphens, or underscores.`);
  }
  return value;
}
function optionalString(value, fieldName, maxLength = 96) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${fieldName} must be a string no longer than ${maxLength} characters.`);
  }
  return value;
}
function requiredNumber(value, fieldName, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be a finite number from ${min} through ${max}.`);
  }
  return value;
}
function optionalNumber(value, fieldName, min, max) {
  if (value === undefined || value === null) {
    return null;
  }
  return requiredNumber(value, fieldName, min, max);
}
function optionalInteger(value, fieldName, min, max) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be an integer from ${min} through ${max}.`);
  }
  return value;
}
function parseMeasurementTime(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept Unix seconds or Unix milliseconds.
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }
  throw new Error("measuredAt must be an ISO date string, Unix seconds, or Unix milliseconds.");
}
function sanitizePayload(body) {
  const siteId = requiredId(body.siteId, "siteId");
  const hubId = requiredId(body.hubId, "hubId");
  const nodeId = requiredId(body.nodeId, "nodeId");
  const readingId = optionalString(body.readingId, "readingId", 96);
  if (readingId !== null && !SAFE_ID.test(readingId)) {
    throw new Error("readingId may contain only letters, numbers, hyphens, or underscores.");
  }
  return {
    siteId,
    hubId,
    nodeId,
    readingId,
    voltage: requiredNumber(body.voltage, "voltage", 0, 100),
    temperatureF: optionalNumber(body.temperatureF, "temperatureF", -100, 300),
    rssi: optionalInteger(body.rssi, "rssi", -200, 50),
    statusCode: optionalInteger(body.statusCode, "statusCode", 0, 255),
    status: optionalString(body.status, "status", 32),
    measuredAt: parseMeasurementTime(body.measuredAt),
    sequence: optionalInteger(body.sequence, "sequence", 0, 4294967295),
    firmwareVersion: optionalString(body.firmwareVersion, "firmwareVersion", 48),
    // v4 identity fields (optional; older firmware omits them).
    deviceUid: optionalString(body.deviceUid, "deviceUid", 32),
    displayName: optionalString(body.displayName, "displayName", 48),
    internalAddress: optionalInteger(body.internalAddress, "internalAddress", 0, 255),
  };
}
exports.ingestReading = onRequest(
    {
      region: REGION,
      secrets: [ingestKey],
      timeoutSeconds: 15,
      memory: "256MiB",
      maxInstances: 10,
      cors: false,
      invoker: "public",
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.set("Allow", "POST");
        return sendJson(res, 405, {ok: false, error: "method_not_allowed"});
      }
      const contentLength = Number(req.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) {
        return sendJson(res, 413, {ok: false, error: "payload_too_large"});
      }
      const providedKey = req.get("x-sentinel-key") || "";
      if (!safeEqual(providedKey, ingestKey.value())) {
        logger.warn("Rejected telemetry request with invalid key", {
          ip: req.ip,
        });
        return sendJson(res, 401, {ok: false, error: "unauthorized"});
      }
      if (!req.is("application/json") || typeof req.body !== "object" || req.body === null) {
        return sendJson(res, 400, {ok: false, error: "json_required"});
      }
      let reading;
      try {
        reading = sanitizePayload(req.body);
      } catch (error) {
        return sendJson(res, 400, {
          ok: false,
          error: "invalid_reading",
          message: error.message,
        });
      }
      const nodeRef = db
          .collection("sites").doc(reading.siteId)
          .collection("hubs").doc(reading.hubId)
          .collection("nodes").doc(reading.nodeId);
      const readingsRef = nodeRef.collection("readings");
      const readingRef = reading.readingId ?
        readingsRef.doc(reading.readingId) : readingsRef.doc();
      const now = FieldValue.serverTimestamp();
      const storedReading = {
        schemaVersion: 2,
        siteId: reading.siteId,
        hubId: reading.hubId,
        nodeId: reading.nodeId,
        deviceUid: reading.deviceUid,
        displayName: reading.displayName,
        internalAddress: reading.internalAddress,
        voltage: reading.voltage,
        temperatureF: reading.temperatureF,
        rssi: reading.rssi,
        statusCode: reading.statusCode,
        status: reading.status,
        sequence: reading.sequence,
        firmwareVersion: reading.firmwareVersion,
        measuredAt: reading.measuredAt,
        receivedAt: now,
      };
      // Node-level identity/name. Written only when present so a reading that
      // omits them never clobbers a previously stored name (hub is the
      // authoritative source and sends displayName on every reading).
      const nodeUpdate = {
        siteId: reading.siteId,
        hubId: reading.hubId,
        nodeId: reading.nodeId,
        latest: storedReading,
        lastSeenAt: now,
        updatedAt: now,
      };
      if (reading.displayName !== null) {
        nodeUpdate.displayName = reading.displayName;
      }
      if (reading.deviceUid !== null) {
        nodeUpdate.deviceUid = reading.deviceUid;
      }
      if (reading.internalAddress !== null) {
        nodeUpdate.internalAddress = reading.internalAddress;
      }
      try {
        await db.runTransaction(async (transaction) => {
          transaction.set(readingRef, storedReading, {merge: false});
          transaction.set(nodeRef, nodeUpdate, {merge: true});
          transaction.set(
              db.collection("sites").doc(reading.siteId),
              {siteId: reading.siteId, updatedAt: now},
              {merge: true},
          );
          transaction.set(
              db.collection("sites").doc(reading.siteId)
                  .collection("hubs").doc(reading.hubId),
              {
                siteId: reading.siteId,
                hubId: reading.hubId,
                lastSeenAt: now,
                updatedAt: now,
              },
              {merge: true},
          );
        });
        logger.info("Telemetry stored", {
          siteId: reading.siteId,
          hubId: reading.hubId,
          nodeId: reading.nodeId,
          readingId: readingRef.id,
        });
        return sendJson(res, 201, {
          ok: true,
          readingId: readingRef.id,
        });
      } catch (error) {
        logger.error("Telemetry write failed", error);
        return sendJson(res, 500, {ok: false, error: "write_failed"});
      }
    },
);
// -----------------------------------------------------------------------------
// Public read-only Sentinel dashboard API
//
// Routes:
//   GET /dashboard/latest
//   GET /dashboard/history
//
// This endpoint exposes approved field-test telemetry only.
// It does not use or reveal the ingest secret.
// -----------------------------------------------------------------------------
const DASHBOARD_ALLOWED_ORIGINS = new Set([
  "https://recoretechnology.com",
  "https://www.recoretechnology.com",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);
const DASHBOARD_RANGES = {
  live: {
    milliseconds: 60 * 60 * 1000,
    limit: 500,
  },
  "24h": {
    milliseconds: 24 * 60 * 60 * 1000,
    limit: 2000,
  },
  "7d": {
    milliseconds: 7 * 24 * 60 * 60 * 1000,
    limit: 5000,
  },
  "30d": {
    milliseconds: 30 * 24 * 60 * 60 * 1000,
    limit: 10000,
  },
};
function applyDashboardCors(req, res) {
  const origin = req.get("origin");
  /*
   * Requests from curl and other non-browser clients may have no Origin
   * header. Browser requests are allowed only from approved origins.
   */
  if (origin && DASHBOARD_ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}
function dashboardTimestampToIso(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
function dashboardReadingToJson(data) {
  const recordedAt =
    dashboardTimestampToIso(data.measuredAt) ||
    dashboardTimestampToIso(data.receivedAt);
  return {
    voltage:
      typeof data.voltage === "number" ? data.voltage : null,
    temperatureF:
      typeof data.temperatureF === "number" ?
        data.temperatureF :
        null,
    rssi:
      Number.isInteger(data.rssi) ? data.rssi : null,
    statusCode:
      Number.isInteger(data.statusCode) ? data.statusCode : null,
    status:
      typeof data.status === "string" ? data.status : null,
    sequence:
      Number.isInteger(data.sequence) ? data.sequence : null,
    firmwareVersion:
      typeof data.firmwareVersion === "string" ?
        data.firmwareVersion :
        null,
    recordedAt,
  };
}
function getDashboardIds(req) {
  return {
    siteId: requiredId(req.query.siteId, "siteId"),
    hubId: requiredId(req.query.hubId, "hubId"),
    nodeId: requiredId(req.query.nodeId, "nodeId"),
  };
}
function getDashboardNodeRef(ids) {
  return db
      .collection("sites").doc(ids.siteId)
      .collection("hubs").doc(ids.hubId)
      .collection("nodes").doc(ids.nodeId);
}
async function handleDashboardLatest(req, res) {
  let ids;
  try {
    ids = getDashboardIds(req);
  } catch (error) {
    return sendJson(res, 400, {
      ok: false,
      error: "invalid_parameters",
      message: error.message,
    });
  }
  try {
    const nodeSnapshot = await getDashboardNodeRef(ids).get();
    if (!nodeSnapshot.exists) {
      return sendJson(res, 404, {
        ok: false,
        error: "node_not_found",
      });
    }
    const nodeData = nodeSnapshot.data() || {};
    const latestData = nodeData.latest;
    if (!latestData || typeof latestData !== "object") {
      return sendJson(res, 404, {
        ok: false,
        error: "no_readings",
      });
    }
    const latest = dashboardReadingToJson(latestData);
    /*
     * Older records may not have a receivedAt value nested inside latest.
     * Fall back to the node-level lastSeenAt field when necessary.
     */
    if (!latest.recordedAt) {
      latest.recordedAt =
        dashboardTimestampToIso(nodeData.lastSeenAt);
    }
    if (
      typeof latest.voltage !== "number" ||
      typeof latest.recordedAt !== "string"
    ) {
      return sendJson(res, 500, {
        ok: false,
        error: "invalid_latest_record",
      });
    }
    return sendJson(res, 200, {
      siteId: ids.siteId,
      hubId: ids.hubId,
      nodeId: ids.nodeId,
      latest,
    });
  } catch (error) {
    logger.error("Dashboard latest query failed", {
      error,
      ...ids,
    });
    return sendJson(res, 500, {
      ok: false,
      error: "latest_query_failed",
    });
  }
}
async function handleDashboardHistory(req, res) {
  let ids;
  try {
    ids = getDashboardIds(req);
  } catch (error) {
    return sendJson(res, 400, {
      ok: false,
      error: "invalid_parameters",
      message: error.message,
    });
  }
  const range =
    typeof req.query.range === "string" ?
      req.query.range :
      "24h";
  const rangeConfig = DASHBOARD_RANGES[range];
  if (!rangeConfig) {
    return sendJson(res, 400, {
      ok: false,
      error: "invalid_range",
      supportedRanges: Object.keys(DASHBOARD_RANGES),
    });
  }
  const cutoff = Timestamp.fromMillis(
      Date.now() - rangeConfig.milliseconds,
  );
  try {
    const readingsSnapshot = await getDashboardNodeRef(ids)
        .collection("readings")
        .where("receivedAt", ">=", cutoff)
        .orderBy("receivedAt", "asc")
        .limit(rangeConfig.limit)
        .get();
    const readings = readingsSnapshot.docs
        .map((document) => dashboardReadingToJson(document.data()))
        .filter((reading) =>
          typeof reading.voltage === "number" &&
          typeof reading.recordedAt === "string",
        );
    return sendJson(res, 200, {
      siteId: ids.siteId,
      hubId: ids.hubId,
      nodeId: ids.nodeId,
      range,
      readings,
    });
  } catch (error) {
    logger.error("Dashboard history query failed", {
      error,
      range,
      ...ids,
    });
    return sendJson(res, 500, {
      ok: false,
      error: "history_query_failed",
    });
  }
}
async function handleDashboardNodes(req, res) {
  let siteId;
  let hubId;
  try {
    siteId = requiredId(req.query.siteId, "siteId");
    hubId = requiredId(req.query.hubId, "hubId");
  } catch (error) {
    return sendJson(res, 400, {
      ok: false,
      error: "invalid_parameters",
      message: error.message,
    });
  }
  try {
    const nodesSnapshot = await db
        .collection("sites").doc(siteId)
        .collection("hubs").doc(hubId)
        .collection("nodes")
        .get();
    const nodes = nodesSnapshot.docs
        .map((document) => {
          const data = document.data() || {};
          const nodeId = data.nodeId || document.id;
          const displayName =
            typeof data.displayName === "string" ? data.displayName : nodeId;
          const assetName =
            typeof data.assetName === "string" ? data.assetName : null;
          const lastSeenAt = dashboardTimestampToIso(data.lastSeenAt);
          const latest =
            data.latest && typeof data.latest === "object" ?
              dashboardReadingToJson(data.latest) :
              null;
          return {nodeId, displayName, assetName, lastSeenAt, latest};
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return sendJson(res, 200, {
      siteId,
      hubId,
      nodes,
    });
  } catch (error) {
    logger.error("Dashboard nodes query failed", {
      error,
      siteId,
      hubId,
    });
    return sendJson(res, 500, {
      ok: false,
      error: "nodes_query_failed",
    });
  }
}
exports.dashboard = onRequest(
    {
      region: REGION,
      timeoutSeconds: 30,
      memory: "256MiB",
      maxInstances: 10,
      cors: false,
      invoker: "public",
    },
    async (req, res) => {
      applyDashboardCors(req, res);
      if (req.method === "OPTIONS") {
        return res.status(204).send("");
      }
      if (req.method !== "GET") {
        res.set("Allow", "GET, OPTIONS");
        return sendJson(res, 405, {
          ok: false,
          error: "method_not_allowed",
        });
      }
      const route = req.path.replace(/\/+$/, "");
      if (route === "/latest") {
        return handleDashboardLatest(req, res);
      }
      if (route === "/history") {
        return handleDashboardHistory(req, res);
      }
      if (route === "/nodes") {
        return handleDashboardNodes(req, res);
      }
      return sendJson(res, 404, {
        ok: false,
        error: "route_not_found",
        routes: [
          "/dashboard/latest",
          "/dashboard/history",
          "/dashboard/nodes",
        ],
      });
    },
);
