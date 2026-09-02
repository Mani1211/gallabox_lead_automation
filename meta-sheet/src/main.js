import { Client, Databases, ID, Query } from "node-appwrite";

/**
 * Google Sheet (Meta / Instagram lead ads) → Meta Ad lead.
 *
 * A Google Apps Script bound to the sheet posts each new (unsynced) row here as
 *   { secret, rowId, data: { "<header>": "<value>", ... } }
 * We map the ad-response fields, keep the whole row as formData, and upsert a
 * `meta_leads` document keyed by rowId (so a re-post never duplicates).
 *
 * Environment variables (Function → Settings → Variables):
 *   META_WEBHOOK_SECRET          – shared secret; must match the Apps Script token
 *   APPWRITE_DATABASE_ID         – target database id
 *   META_LEADS_COLLECTION_ID     – target collection id for meta leads
 *   APPWRITE_API_KEY             – (optional) server key; else the injected key is used
 * Appwrite injects APPWRITE_FUNCTION_API_ENDPOINT and APPWRITE_FUNCTION_PROJECT_ID.
 */

export default async ({ req, res, log, error }) => {
  // ── 1. Parse body ─────────────────────────────────────────────────────────
  let body = {};
  try {
    body = req.bodyJson ?? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {});
  } catch (e) {
    error(`Could not parse body as JSON: ${e.message}`);
    return res.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  // ── 2. Auth (shared secret) ───────────────────────────────────────────────
  const expected = process.env.META_WEBHOOK_SECRET || "";
  const got = body.secret || req.headers["x-meta-secret"] || "";
  if (!expected || got !== expected) {
    error("Rejected: missing/invalid secret.");
    return res.json({ success: false, error: "Unauthorized" }, 401);
  }

  const rowId = String(body.rowId || "").trim();
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (!rowId) return res.json({ success: false, error: "rowId is required" }, 400);
  if (Object.keys(data).length === 0) return res.json({ success: false, error: "empty row data" }, 400);

  log(`Meta sheet row received. rowId=${rowId} keys=${Object.keys(data).join(", ")}`);

  // ── 3. Map the ad-response fields (case/space/punctuation-insensitive) ─────
  const name = pick(data, ["first_name", "full_name", "name"]);
  const mobileNumber = normalizePhone(pick(data, ["phone_number", "phone", "mobile", "mobile_number"]));
  const email = pick(data, ["email", "email_address"]);
  const city = pick(data, ["city"]);
  const campaign = pick(data, ["campaign_name", "campaign"]);
  const adSet = pick(data, ["ad_set_audience", "ad_set", "adset", "audience"]);
  const destinationInterest = pick(data, ["destination_interest", "destination_video_or_image", "destination"]);

  const doc = {
    name,
    mobileNumber,
    email,
    city,
    campaign,
    adSet,
    destinationInterest,
    contactId: rowId, // reuse a generic external id; keeps parity with other lead types
    source: "meta",
    // Whole sheet row as JSON; the Leads UI parses it and shows the filled fields.
    formData: safeStringify(data),
  };

  // ── 4. Upsert by rowId ────────────────────────────────────────────────────
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY || req.headers["x-appwrite-key"] || "");
  const databases = new Databases(client);
  const DB = process.env.APPWRITE_DATABASE_ID;
  const COLLECTION = process.env.META_LEADS_COLLECTION_ID;

  try {
    const { documents } = await databases.listDocuments(DB, COLLECTION, [
      Query.equal("contactId", rowId),
      Query.limit(1),
    ]);
    if (documents[0]) {
      const updated = await databases.updateDocument(DB, COLLECTION, documents[0].$id, doc);
      log(`Updated meta lead ${updated.$id} for row ${rowId}`);
      return res.json({ success: true, action: "updated", id: updated.$id });
    }
    const created = await databases.createDocument(DB, COLLECTION, ID.unique(), doc);
    log(`Created meta lead ${created.$id} for row ${rowId}`);
    return res.json({ success: true, action: "created", id: created.$id, name, mobileNumber });
  } catch (e) {
    error(`Appwrite write failed: ${e.message}`);
    return res.json({ success: false, error: `Appwrite write failed: ${e.message}` }, 500);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Case/space/punctuation-insensitive lookup over the row's header keys.
function pick(obj, candidates) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const map = {};
  for (const k of Object.keys(obj || {})) map[norm(k)] = obj[k];
  for (const c of candidates) {
    const v = map[norm(c)];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Country calling codes we recognise, to strip the dialing code and keep the
// local number (matches the Gallabox function's behaviour).
const COUNTRY_CODES = [
  "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98", "211", "212", "213", "216", "218", "230", "248", "249", "351", "352",
  "353", "354", "355", "356", "357", "358", "359", "852", "853", "855", "856", "880", "886", "960", "961", "962",
  "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975", "976", "977", "992", "993",
  "994", "995", "996", "998",
];

function normalizePhone(raw) {
  if (!raw) return "";
  const hadIntlPrefix = /^\s*(\+|00)/.test(String(raw));
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!hadIntlPrefix && digits.length <= 10) return digits;
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (digits.startsWith(code)) {
      const local = digits.slice(code.length);
      if (local.length >= 6 && local.length <= 11) return local;
    }
  }
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function safeStringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
