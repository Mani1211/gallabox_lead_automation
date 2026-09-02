/**
 * TourOn — Meta Ad Leads sheet sync.
 * Paste this into the Google Sheet's Apps Script editor (Extensions → Apps Script),
 * fill the CONFIG below, then run setupTrigger() once and markAllSyncedBaseline() once.
 *
 * It posts every new (unsynced) row that has a phone number to the Appwrite
 * function, which creates a Meta Ad lead. Two helper columns are added and
 * managed automatically: "Lead ID" (stable id, used for dedup) and "Synced At".
 */

// ── CONFIG ────────────────────────────────────────────────────────────────
var WEBHOOK_URL = "https://YOUR-META-FUNCTION-DOMAIN.appwrite.run/"; // the meta-sheet function URL
var SECRET = "CHANGE_ME"; // must match META_WEBHOOK_SECRET on the function
var BRANCH = "Chennai"; // this sheet's branch — e.g. "Chennai" or "Bangalore" (stored on each lead)
var SHEET_NAME = ""; // exact tab name; leave "" to use the first sheet
var HEADER_ROW = 2; // 1-based row that holds the REAL field names (row 1 here is section labels)
var PHONE_HEADER = "phone_number"; // header whose non-empty value marks a real lead
var LEAD_ID_HEADER = "Lead ID";
var SYNCED_HEADER = "Synced At";

// ── Main sync (run on a time trigger) ─────────────────────────────────────
function syncMetaLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length <= HEADER_ROW) return;

  var h = HEADER_ROW - 1; // 0-based header row index
  var headers = values[h].map(function (x) { return String(x).trim(); });
  var leadIdCol = headers.indexOf(LEAD_ID_HEADER);
  var syncedCol = headers.indexOf(SYNCED_HEADER);
  var changed = false;
  if (leadIdCol === -1) { headers.push(LEAD_ID_HEADER); leadIdCol = headers.length - 1; changed = true; }
  if (syncedCol === -1) { headers.push(SYNCED_HEADER); syncedCol = headers.length - 1; changed = true; }
  if (changed) sheet.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);

  var phoneCol = headers.indexOf(PHONE_HEADER);
  if (phoneCol === -1) {
    Logger.log("phone_number column not found in header row " + HEADER_ROW + " — check HEADER_ROW / PHONE_HEADER.");
    return;
  }

  for (var r = HEADER_ROW; r < values.length; r++) { // data starts right after the header row
    var row = values[r];
    var synced = row[syncedCol];
    var phone = String(row[phoneCol] || "").trim();
    if (synced || !phone) continue; // skip already-synced rows and rows with no phone

    var data = {};
    for (var c = 0; c < headers.length; c++) {
      if (c === leadIdCol || c === syncedCol) continue;
      var key = headers[c];
      if (!key) continue;
      var val = row[c];
      if (val !== "" && val != null) data[key] = val instanceof Date ? val.toISOString() : val;
    }

    var rowId = String(row[leadIdCol] || "").trim();
    if (!rowId) {
      rowId = Utilities.getUuid();
      sheet.getRange(r + 1, leadIdCol + 1).setValue(rowId);
    }

    try {
      var resp = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ secret: SECRET, rowId: rowId, branch: BRANCH, data: data }),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        sheet.getRange(r + 1, syncedCol + 1).setValue(new Date());
      } else {
        Logger.log("Row " + (r + 1) + " failed: " + code + " " + resp.getContentText());
      }
    } catch (e) {
      Logger.log("Row " + (r + 1) + " error: " + e);
    }
  }
}

// ── Run ONCE: create the 5-minute trigger ─────────────────────────────────
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncMetaLeads") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncMetaLeads").timeBased().everyMinutes(5).create();
}

// ── Run ONCE: baseline existing rows so only NEW rows sync from now on ─────
function markAllSyncedBaseline() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  var h = HEADER_ROW - 1;
  var headers = values[h].map(function (x) { return String(x).trim(); });
  var syncedCol = headers.indexOf(SYNCED_HEADER);
  if (syncedCol === -1) {
    headers.push(SYNCED_HEADER);
    syncedCol = headers.length - 1;
    sheet.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
  }
  for (var r = HEADER_ROW; r < values.length; r++) {
    if (!sheet.getRange(r + 1, syncedCol + 1).getValue()) {
      sheet.getRange(r + 1, syncedCol + 1).setValue("baseline");
    }
  }
}

// ── Diagnostic: run and read the Execution log ────────────────────────────
function debugSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  Logger.log("Sheet used: " + (sheet ? sheet.getName() : "NULL"));
  if (!sheet) return;
  var values = sheet.getDataRange().getValues();
  var h = HEADER_ROW - 1;
  var headers = values[h].map(function (x) { return String(x).trim(); });
  Logger.log("Header row " + HEADER_ROW + ": " + JSON.stringify(headers));
  var phoneCol = headers.indexOf(PHONE_HEADER);
  var syncedCol = headers.indexOf(SYNCED_HEADER);
  Logger.log("phoneCol: " + phoneCol + "   syncedCol: " + syncedCol);
  var unsynced = 0;
  for (var r = HEADER_ROW; r < values.length; r++) {
    var phone = phoneCol > -1 ? String(values[r][phoneCol] || "").trim() : "";
    var synced = syncedCol > -1 ? values[r][syncedCol] : "";
    if (!synced && phone) unsynced++;
  }
  Logger.log("Unsynced rows WITH phone: " + unsynced);
}
