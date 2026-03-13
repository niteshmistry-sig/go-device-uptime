/**
 * GO Device Uptime — main.js
 * MyGeotab Add-In: monitors device communication health and detects gaps.
 */

/* global geotab */
if (typeof geotab === "undefined") { var geotab = { addin: {} }; }

geotab.addin.goDeviceUptime = function () {
  "use strict";

  // ── State ──
  var api;
  var abortController = null;
  var firstFocus = true;

  var allDevices = [];
  var allGroups = [];
  var mergedDevices = [];

  var deviceSort = { col: "status", dir: "asc" };
  var gapSort = { col: "start", dir: "asc" };
  var statusFilter = "";
  var lastGaps = [];
  var lastFromISO = "";
  var lastToISO = "";

  // ── DOM refs (cached in initialize) ──
  var els = {};

  // ══════════════════════════════════════════
  //  Helpers
  // ══════════════════════════════════════════
  function apiGet(typeName, search) {
    return new Promise(function (resolve, reject) {
      api.call("Get", { typeName: typeName, search: search || {} }, resolve, reject);
    });
  }

  function apiMultiCall(calls) {
    return new Promise(function (resolve, reject) {
      api.multiCall(calls, resolve, reject);
    });
  }

  function isAborted() {
    return abortController && abortController.signal && abortController.signal.aborted;
  }

  function escHtml(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    var totalMin = Math.floor(ms / 60000);
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    var parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
  }

  function formatDateTime(iso) {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleString();
  }

  function timeSince(iso) {
    if (!iso) return "\u2014";
    return formatDuration(Date.now() - new Date(iso).getTime());
  }

  function sortArrow(col, sortState) {
    if (sortState.col === col) {
      return '<span class="gud-sort-arrow active">' + (sortState.dir === "asc" ? "\u25B2" : "\u25BC") + "</span>";
    }
    return '<span class="gud-sort-arrow">\u25B2\u25BC</span>';
  }

  function showLoading(show, msg) {
    els.loading.style.display = show ? "" : "none";
    if (msg) els.loadingText.textContent = msg;
  }

  function showEmpty(show, msg) {
    els.empty.style.display = show ? "" : "none";
    if (msg) els.empty.querySelector("p").textContent = msg;
  }

  function setDefaults() {
    var now = new Date();
    var week = new Date(now.getTime() - 7 * 86400000);
    function fmt(d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + "T" + String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0");
    }
    els.gapFrom.value = fmt(week);
    els.gapTo.value = fmt(now);
  }

  function pillClass(cause) {
    if (!cause) return "gud-pill-info";
    if (cause.indexOf("Unplugged") >= 0) return "gud-pill-error";
    if (cause.indexOf("Low Voltage Restart") >= 0) return "gud-pill-error";
    if (cause.indexOf("Low Battery") >= 0) return "gud-pill-warning";
    if (cause.indexOf("Ignition") >= 0) return "gud-pill-success";
    if (cause.indexOf("Cellular") >= 0) return "gud-pill-info";
    return "gud-pill-info";
  }

  // ══════════════════════════════════════════
  //  Tab Switching
  // ══════════════════════════════════════════
  function switchTab(name) {
    var root = document.getElementById("gud-root");
    root.querySelectorAll(".gud-tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    root.querySelectorAll(".gud-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "gud-panel-" + name);
    });
  }

  // ══════════════════════════════════════════
  //  Foundation Data (loaded in initialize)
  // ══════════════════════════════════════════
  function loadFoundation(callback) {
    api.multiCall([
      ["Get", { typeName: "Device", resultsLimit: 5000 }],
      ["Get", { typeName: "Group", resultsLimit: 5000 }]
    ], function (results) {
      var now = new Date();
      allDevices = (results[0] || []).filter(function (d) {
        return !d.activeTo || new Date(d.activeTo) > now;
      });
      allGroups = results[1] || [];
      buildGroupFilter();
      populateDeviceSelector();
      callback();
    }, function (err) {
      console.error("Foundation load error:", err);
      callback();
    });
  }

  function buildGroupFilter() {
    els.groupFilter.innerHTML = '<option value="">All Groups</option>';
    var groupMap = {};
    allGroups.forEach(function (g) {
      if (g.name && g.id !== "GroupCompanyId") groupMap[g.id] = g.name;
    });
    var usedGroups = {};
    allDevices.forEach(function (d) {
      if (d.groups) d.groups.forEach(function (g) {
        if (groupMap[g.id]) usedGroups[g.id] = groupMap[g.id];
      });
    });
    Object.keys(usedGroups)
      .sort(function (a, b) { return usedGroups[a].localeCompare(usedGroups[b]); })
      .forEach(function (id) {
        var opt = document.createElement("option");
        opt.value = id;
        opt.textContent = usedGroups[id];
        els.groupFilter.appendChild(opt);
      });
  }

  function populateDeviceSelector() {
    els.gapDevice.innerHTML = '<option value="">-- Select Device --</option>';
    allDevices.slice()
      .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); })
      .forEach(function (d) {
        var opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name + (d.serialNumber ? " (" + d.serialNumber + ")" : "");
        els.gapDevice.appendChild(opt);
      });
  }

  // ══════════════════════════════════════════
  //  Real-Time Status
  // ══════════════════════════════════════════
  function loadRealtimeStatus() {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    showLoading(true, "Loading device status\u2026");
    showEmpty(false);

    apiMultiCall([
      ["Get", { typeName: "Device", resultsLimit: 5000 }],
      ["Get", { typeName: "DeviceStatusInfo" }]
    ]).then(function (results) {
      if (isAborted()) return;
      var now = new Date();
      allDevices = (results[0] || []).filter(function (d) {
        return !d.activeTo || new Date(d.activeTo) > now;
      });
      var allStatusInfo = results[1] || [];

      // Merge
      var statusMap = {};
      allStatusInfo.forEach(function (si) {
        if (si.device) statusMap[si.device.id] = si;
      });

      mergedDevices = allDevices.map(function (d) {
        var si = statusMap[d.id] || {};
        var lastComm = si.dateTime || null;
        var msSince = lastComm ? (Date.now() - new Date(lastComm).getTime()) : Infinity;
        var status, statusClass;
        if (si.isDeviceCommunicating) {
          status = msSince > 3600000 ? "Stale" : "Communicating";
          statusClass = msSince > 3600000 ? "warning" : "success";
        } else {
          if (msSince > 86400000) { status = "Not Communicating"; statusClass = "error"; }
          else if (msSince > 3600000) { status = "Stale"; statusClass = "warning"; }
          else { status = "Communicating"; statusClass = "success"; }
        }
        return {
          id: d.id, name: d.name || "(unnamed)", serialNumber: d.serialNumber || "\u2014",
          groups: d.groups || [], status: status, statusClass: statusClass,
          lastComm: lastComm, msSince: msSince, lat: si.latitude, lng: si.longitude
        };
      });

      populateDeviceSelector();
      renderDeviceTable();
      showLoading(false);
    }).catch(function (err) {
      if (isAborted()) return;
      showLoading(false);
      showEmpty(true, "Error loading devices: " + (err.message || err));
    });
  }

  function renderDeviceTable() {
    var gf = els.groupFilter.value;
    var search = els.search.value.trim().toLowerCase();
    var filtered = mergedDevices;

    if (gf) {
      filtered = filtered.filter(function (d) {
        return d.groups.some(function (g) { return g.id === gf; });
      });
    }
    if (statusFilter) {
      filtered = filtered.filter(function (d) { return d.statusClass === statusFilter; });
    }
    if (search) {
      filtered = filtered.filter(function (d) {
        return d.name.toLowerCase().indexOf(search) >= 0 ||
          d.serialNumber.toLowerCase().indexOf(search) >= 0 ||
          d.status.toLowerCase().indexOf(search) >= 0;
      });
    }

    // Sort
    var statusOrder = { error: 0, warning: 1, success: 2 };
    var col = deviceSort.col, dir = deviceSort.dir === "asc" ? 1 : -1;
    filtered.sort(function (a, b) {
      var va, vb;
      switch (col) {
        case "name": va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case "serial": va = a.serialNumber.toLowerCase(); vb = b.serialNumber.toLowerCase(); break;
        case "status": va = statusOrder[a.statusClass] || 9; vb = statusOrder[b.statusClass] || 9; break;
        case "lastComm": va = a.lastComm ? new Date(a.lastComm).getTime() : 0; vb = b.lastComm ? new Date(b.lastComm).getTime() : 0; break;
        case "timeSince": va = a.msSince; vb = b.msSince; break;
        case "location": va = (a.lat || 0) + (a.lng || 0); vb = (b.lat || 0) + (b.lng || 0); break;
        default: va = a.name; vb = b.name;
      }
      return va < vb ? -1 * dir : va > vb ? 1 * dir : 0;
    });

    // KPIs (from group-filtered set, ignoring search/status filters)
    var allFiltered = mergedDevices;
    if (gf) { allFiltered = allFiltered.filter(function (d) { return d.groups.some(function (g) { return g.id === gf; }); }); }
    var total = allFiltered.length;
    var green = allFiltered.filter(function (d) { return d.statusClass === "success"; }).length;
    var yellow = allFiltered.filter(function (d) { return d.statusClass === "warning"; }).length;
    var red = allFiltered.filter(function (d) { return d.statusClass === "error"; }).length;

    els.kpiStrip.style.display = "flex";
    document.getElementById("gud-kpi-total").textContent = total;
    document.getElementById("gud-kpi-comm").textContent = green;
    document.getElementById("gud-kpi-stale").textContent = yellow;
    document.getElementById("gud-kpi-offline").textContent = red;

    // Update headers with sort arrows
    var thead = els.deviceTable.querySelector("thead");
    thead.innerHTML = "<tr>" +
      '<th class="gud-sortable" data-sort="name">Device Name ' + sortArrow("name", deviceSort) + "</th>" +
      '<th class="gud-sortable" data-sort="serial">Serial Number ' + sortArrow("serial", deviceSort) + "</th>" +
      '<th class="gud-sortable" data-sort="status">Status ' + sortArrow("status", deviceSort) + "</th>" +
      '<th class="gud-sortable" data-sort="lastComm">Last Data Received ' + sortArrow("lastComm", deviceSort) + "</th>" +
      '<th class="gud-sortable" data-sort="timeSince">Time Since Last Comm ' + sortArrow("timeSince", deviceSort) + "</th>" +
      '<th class="gud-sortable" data-sort="location">Location ' + sortArrow("location", deviceSort) + "</th>" +
      "</tr>";

    // Rows
    var tbody = els.deviceTbody;
    tbody.innerHTML = "";

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#999;">No devices match your filters</td></tr>';
      showEmpty(false);
      return;
    }

    filtered.forEach(function (d) {
      var loc = (d.lat != null && d.lng != null && d.lat !== 0 && d.lng !== 0)
        ? d.lat.toFixed(4) + ", " + d.lng.toFixed(4) : "\u2014";
      var tr = document.createElement("tr");
      tr.className = "gud-row-" + d.statusClass;
      tr.innerHTML =
        "<td><strong>" + escHtml(d.name) + "</strong></td>" +
        "<td>" + escHtml(d.serialNumber) + "</td>" +
        '<td><span class="gud-dot gud-dot-' + d.statusClass + '"></span>' + d.status + "</td>" +
        "<td>" + formatDateTime(d.lastComm) + "</td>" +
        "<td>" + timeSince(d.lastComm) + "</td>" +
        "<td>" + loc + "</td>";
      tbody.appendChild(tr);
    });

    showEmpty(false);
  }

  // ══════════════════════════════════════════
  //  Historical Gap Analysis
  // ══════════════════════════════════════════
  function analyzeGaps() {
    var deviceId = els.gapDevice.value;
    var fromDate = els.gapFrom.value;
    var toDate = els.gapTo.value;
    var threshold = parseInt(els.gapThreshold.value, 10) || 30;

    if (!deviceId) { alert("Select a device."); return; }
    if (!fromDate || !toDate) { alert("Select a date range."); return; }

    if (abortController) abortController.abort();
    abortController = new AbortController();

    var fromISO = new Date(fromDate).toISOString();
    var toISO = new Date(toDate).toISOString();
    var thresholdMs = threshold * 60 * 1000;

    showLoading(true, "Analyzing communication gaps\u2026");
    els.gapKpiStrip.style.display = "none";

    apiGet("LogRecord", {
      deviceSearch: { id: deviceId }, fromDate: fromISO, toDate: toISO
    }).then(function (records) {
      if (isAborted()) return;
      records = records || [];

      if (records.length < 2) {
        showLoading(false);
        renderGapTable([], fromISO, toISO);
        return;
      }

      records.sort(function (a, b) { return new Date(a.dateTime) - new Date(b.dateTime); });

      var gaps = [];
      for (var i = 1; i < records.length; i++) {
        var t1 = new Date(records[i - 1].dateTime).getTime();
        var t2 = new Date(records[i].dateTime).getTime();
        if (t2 - t1 > thresholdMs) {
          gaps.push({ start: records[i - 1].dateTime, end: records[i].dateTime, durationMs: t2 - t1, cause: null });
        }
      }

      if (gaps.length === 0) {
        showLoading(false);
        renderGapTable(gaps, fromISO, toISO);
        return;
      }

      return analyzeCauses(deviceId, gaps).then(function (analyzedGaps) {
        if (isAborted()) return;
        showLoading(false);
        renderGapTable(analyzedGaps, fromISO, toISO);
      });
    }).catch(function (err) {
      if (isAborted()) return;
      showLoading(false);
      alert("Error: " + (err.message || err));
    });
  }

  function analyzeCauses(deviceId, gaps) {
    var promises = gaps.map(function (gap) {
      var ws = new Date(new Date(gap.start).getTime() - 3600000).toISOString();
      var we = new Date(new Date(gap.end).getTime() + 3600000).toISOString();

      return apiMultiCall([
        ["Get", { typeName: "FaultData", search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: "DiagnosticDeviceHasBeenUnpluggedId" }, fromDate: ws, toDate: we } }],
        ["Get", { typeName: "FaultData", search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: "DiagnosticDeviceRestartedBecauseOfLowVoltageInPowerSupplyId" }, fromDate: ws, toDate: we } }],
        ["Get", { typeName: "StatusData", search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: "DiagnosticGoDeviceVoltageId" }, fromDate: ws, toDate: we } }],
        ["Get", { typeName: "StatusData", search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: "DiagnosticIgnitionId" }, fromDate: ws, toDate: we } }],
        ["Get", { typeName: "StatusData", search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: "DiagnosticCellularRssiId" }, fromDate: ws, toDate: we } }]
      ]).then(function (r) {
        gap.cause = determineCause(gap, r[0] || [], r[1] || [], r[2] || [], r[3] || [], r[4] || []);
        return gap;
      }).catch(function () {
        gap.cause = "Unknown \u2014 Analysis Error";
        return gap;
      });
    });
    return Promise.all(promises);
  }

  function determineCause(gap, unplugged, lowVoltageRestart, voltageData, ignitionData, rssiData) {
    if (unplugged.length > 0) return "Device Unplugged";
    if (lowVoltageRestart.length > 0) return "Low Voltage Restart";

    var gapStart = new Date(gap.start).getTime();
    var preVoltage = voltageData.filter(function (v) {
      var t = new Date(v.dateTime).getTime();
      return t <= gapStart && t >= gapStart - 3600000;
    });
    if (preVoltage.length > 0) {
      var volts = preVoltage[preVoltage.length - 1].data;
      if (volts > 100) volts = volts / 1000;
      if (volts < 6) return "Low Battery / Power Loss";
    }

    var gapEnd = new Date(gap.end).getTime();
    var gapIgnition = ignitionData.filter(function (v) {
      var t = new Date(v.dateTime).getTime();
      return t >= gapStart - 3600000 && t <= gapEnd + 3600000;
    });
    if (gapIgnition.length > 0 && gapIgnition.every(function (v) { return v.data === 0; })) {
      return "Ignition Off (Low-Power Mode)";
    }

    var preRssi = rssiData.filter(function (v) {
      var t = new Date(v.dateTime).getTime();
      return t <= gapStart && t >= gapStart - 3600000;
    });
    if (preRssi.length > 0 && preRssi[preRssi.length - 1].data < -100) {
      return "Weak Cellular Signal";
    }

    return "Unknown \u2014 Possible Network Issue";
  }

  function renderGapTable(gaps, fromISO, toISO) {
    lastGaps = gaps;
    lastFromISO = fromISO;
    lastToISO = toISO;

    // KPIs
    var periodMs = new Date(toISO).getTime() - new Date(fromISO).getTime();
    var totalGapMs = gaps.reduce(function (s, g) { return s + g.durationMs; }, 0);
    var uptimePct = periodMs > 0 ? (((periodMs - totalGapMs) / periodMs) * 100).toFixed(1) : "100.0";
    var longest = gaps.reduce(function (m, g) { return g.durationMs > m ? g.durationMs : m; }, 0);

    var causeCounts = {};
    gaps.forEach(function (g) { causeCounts[g.cause || "Unknown"] = (causeCounts[g.cause || "Unknown"] || 0) + 1; });
    var commonCause = "\u2014", maxC = 0;
    Object.keys(causeCounts).forEach(function (c) { if (causeCounts[c] > maxC) { maxC = causeCounts[c]; commonCause = c; } });

    els.gapKpiStrip.style.display = "flex";
    document.getElementById("gud-kpi-uptime").textContent = uptimePct + "%";
    document.getElementById("gud-kpi-gaps").textContent = gaps.length;
    document.getElementById("gud-kpi-longest").textContent = longest > 0 ? formatDuration(longest) : "\u2014";
    document.getElementById("gud-kpi-cause").textContent = gaps.length > 0 ? commonCause : "\u2014";

    // Cause filter
    var causeFilterVal = els.causeFilter.value;
    var filtered = gaps;
    if (causeFilterVal) {
      filtered = gaps.filter(function (g) { return g.cause === causeFilterVal; });
    }

    // Populate cause dropdown
    var uniqueCauses = {};
    gaps.forEach(function (g) { if (g.cause) uniqueCauses[g.cause] = true; });
    var opts = '<option value="">All Causes</option>';
    Object.keys(uniqueCauses).sort().forEach(function (c) {
      opts += '<option value="' + escHtml(c) + '"' + (causeFilterVal === c ? " selected" : "") + '>' + escHtml(c) + '</option>';
    });
    els.causeFilter.innerHTML = opts;

    // Sort
    var col = gapSort.col, dir = gapSort.dir === "asc" ? 1 : -1;
    var sorted = filtered.slice().sort(function (a, b) {
      var va, vb;
      switch (col) {
        case "start": va = new Date(a.start).getTime(); vb = new Date(b.start).getTime(); break;
        case "end": va = new Date(a.end).getTime(); vb = new Date(b.end).getTime(); break;
        case "duration": va = a.durationMs; vb = b.durationMs; break;
        case "cause": va = (a.cause || "").toLowerCase(); vb = (b.cause || "").toLowerCase(); break;
        default: va = new Date(a.start).getTime(); vb = new Date(b.start).getTime();
      }
      return va < vb ? -1 * dir : va > vb ? 1 * dir : 0;
    });

    // Update headers
    var thead = els.gapTable.querySelector("thead");
    thead.innerHTML = "<tr>" +
      "<th>#</th>" +
      '<th class="gud-sortable" data-sort="start">Gap Start ' + sortArrow("start", gapSort) + "</th>" +
      '<th class="gud-sortable" data-sort="end">Gap End ' + sortArrow("end", gapSort) + "</th>" +
      '<th class="gud-sortable" data-sort="duration">Duration ' + sortArrow("duration", gapSort) + "</th>" +
      '<th class="gud-sortable" data-sort="cause">Probable Cause ' + sortArrow("cause", gapSort) + "</th>" +
      "</tr>";

    // Rows
    var tbody = els.gapTbody;
    tbody.innerHTML = "";

    if (sorted.length === 0) {
      var msg = gaps.length === 0
        ? "No communication gaps detected \u2014 continuous uptime during this period."
        : "No gaps match the selected cause filter.";
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#4caf50;">' + msg + "</td></tr>";
      return;
    }

    sorted.forEach(function (g, i) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + (i + 1) + "</td>" +
        "<td>" + formatDateTime(g.start) + "</td>" +
        "<td>" + formatDateTime(g.end) + "</td>" +
        "<td>" + formatDuration(g.durationMs) + "</td>" +
        '<td><span class="gud-pill ' + pillClass(g.cause) + '">' + escHtml(g.cause) + "</span></td>";
      tbody.appendChild(tr);
    });
  }

  // ══════════════════════════════════════════
  //  Event Wiring
  // ══════════════════════════════════════════
  function wireEvents() {
    // Tabs (delegation)
    document.getElementById("gud-tabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".gud-tab");
      if (tab) switchTab(tab.getAttribute("data-tab"));
    });

    // Refresh
    els.refresh.addEventListener("click", function () {
      loadRealtimeStatus();
    });

    // Analyze
    els.analyze.addEventListener("click", function () {
      analyzeGaps();
    });

    // Group filter
    els.groupFilter.addEventListener("change", function () {
      renderDeviceTable();
    });

    // Search
    els.search.addEventListener("input", function () {
      renderDeviceTable();
    });

    // Status chips (delegation)
    document.getElementById("gud-status-chips").addEventListener("click", function (e) {
      var chip = e.target.closest(".gud-chip");
      if (!chip) return;
      statusFilter = chip.getAttribute("data-status") || "";
      document.getElementById("gud-root").querySelectorAll("#gud-status-chips .gud-chip").forEach(function (c) {
        c.classList.remove("active");
      });
      chip.classList.add("active");
      renderDeviceTable();
    });

    // Table sorting (delegation on content)
    document.getElementById("gud-content").addEventListener("click", function (e) {
      var th = e.target.closest("th.gud-sortable");
      if (!th) return;
      var col = th.getAttribute("data-sort");
      if (!col) return;
      var table = th.closest("table");
      if (!table) return;

      if (table.id === "gud-device-table") {
        if (deviceSort.col === col) { deviceSort.dir = deviceSort.dir === "asc" ? "desc" : "asc"; }
        else { deviceSort.col = col; deviceSort.dir = "asc"; }
        renderDeviceTable();
      } else if (table.id === "gud-gap-table") {
        if (gapSort.col === col) { gapSort.dir = gapSort.dir === "asc" ? "desc" : "asc"; }
        else { gapSort.col = col; gapSort.dir = "asc"; }
        renderGapTable(lastGaps, lastFromISO, lastToISO);
      }
    });

    // Cause filter (delegation since select is in the toolbar)
    els.causeFilter.addEventListener("change", function () {
      renderGapTable(lastGaps, lastFromISO, lastToISO);
    });
  }

  // ══════════════════════════════════════════
  //  MyGeotab Lifecycle
  // ══════════════════════════════════════════
  return {
    initialize: function (freshApi, state, callback) {
      api = freshApi;

      // Cache DOM refs
      els.loading = document.getElementById("gud-loading");
      els.loadingText = document.getElementById("gud-loading-text");
      els.empty = document.getElementById("gud-empty");
      els.kpiStrip = document.getElementById("gud-kpi-strip");
      els.gapKpiStrip = document.getElementById("gud-gap-kpi-strip");
      els.groupFilter = document.getElementById("gud-group-filter");
      els.search = document.getElementById("gud-search");
      els.refresh = document.getElementById("gud-refresh");
      els.analyze = document.getElementById("gud-analyze");
      els.gapDevice = document.getElementById("gud-gap-device");
      els.gapFrom = document.getElementById("gud-gap-from");
      els.gapTo = document.getElementById("gud-gap-to");
      els.gapThreshold = document.getElementById("gud-gap-threshold");
      els.causeFilter = document.getElementById("gud-cause-filter");
      els.deviceTable = document.getElementById("gud-device-table");
      els.deviceTbody = document.getElementById("gud-device-tbody");
      els.gapTable = document.getElementById("gud-gap-table");
      els.gapTbody = document.getElementById("gud-gap-tbody");

      // Wire events
      wireEvents();

      // Set defaults
      setDefaults();

      // Load foundation data then callback
      if (api) {
        loadFoundation(callback);
      } else {
        callback();
      }
    },

    focus: function (freshApi, state) {
      api = freshApi;

      if (firstFocus) {
        firstFocus = false;
        if (api) loadRealtimeStatus();
      }
    },

    blur: function () {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      showLoading(false);
    }
  };
};

// ══════════════════════════════════════════
//  Standalone Mode (preview outside MyGeotab)
// ══════════════════════════════════════════
(function () {
  setTimeout(function () {
    if (typeof geotab !== "undefined" && typeof geotab.addin.goDeviceUptime === "function") {
      // Check if MyGeotab already invoked the factory
      var root = document.getElementById("gud-root");
      if (root && !root._initialized) {
        root._initialized = true;
        var addin = geotab.addin.goDeviceUptime();
        addin.initialize(null, {}, function () {
          addin.focus(null, {});
        });
      }
    }
  }, 2000);
})();
