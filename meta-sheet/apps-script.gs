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
var SHEET_NAME = ""; // exact tab name; leave "" to use the first sheet
var PHONE_HEADER = "phone_number"; // header whose non-empty value marks a real lead
var LEAD_ID_HEADER = "Lead ID";
var SYNCED_HEADER = "Synced At";

// ── Main sync (run on a time trigger) ─────────────────────────────────────
function syncMetaLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var leadIdCol = headers.indexOf(LEAD_ID_HEADER);
  var syncedCol = headers.indexOf(SYNCED_HEADER);
  var changed = false;
  if (leadIdCol === -1) { headers.push(LEAD_ID_HEADER); leadIdCol = headers.length - 1; changed = true; }
  if (syncedCol === -1) { headers.push(SYNCED_HEADER); syncedCol = headers.length - 1; changed = true; }
  if (changed) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  var phoneCol = headers.indexOf(PHONE_HEADER);

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var synced = row[syncedCol];
    var phone = phoneCol > -1 ? String(row[phoneCol] || "").trim() : "";
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
        payload: JSON.stringify({ secret: SECRET, rowId: rowId, data: data }),
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
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var syncedCol = headers.indexOf(SYNCED_HEADER);
  if (syncedCol === -1) {
    headers.push(SYNCED_HEADER);
    syncedCol = headers.length - 1;
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  for (var r = 1; r < values.length; r++) {
    if (!sheet.getRange(r + 1, syncedCol + 1).getValue()) {
      sheet.getRange(r + 1, syncedCol + 1).setValue("baseline");
    }
  }
}
