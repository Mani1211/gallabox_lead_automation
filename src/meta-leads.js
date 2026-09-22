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
  // ── 1. Parse body (robust across Appwrite runtime shapes) ─────────────────
  let body = {};
  if (req.bodyJson && typeof req.bodyJson === "object") {
    body = req.bodyJson;
  } else if (req.body && typeof req.body === "object") {
    body = req.body;
  } else {
    const raw = String(req.bodyRaw ?? req.bodyText ?? (typeof req.body === "string" ? req.body : "") ?? "").trim();
    if (!raw) {
      // Empty body — health check / warm ping / console execute. No-op, not an error.
      log("Empty request body — nothing to do (ping).");
      return res.json({ success: true, skipped: "empty body" }, 200);
    }
    try {
      body = JSON.parse(raw);
    } catch (e) {
      error(`Invalid JSON body: ${e.message}`);
      return res.json({ success: false, error: "Invalid JSON body" }, 400);
    }
  }

  // ── 2. Auth (shared secret) ───────────────────────────────────────────────
  const expected = process.env.META_WEBHOOK_SECRET || "";
  const got = body.secret || req.headers["x-meta-secret"] || "";
  if (!expected || got !== expected) {
    error("Rejected: missing/invalid secret.");
    return res.json({ success: false, error: "Unauthorized" }, 401);
  }

  const rowId = String(body.rowId || "").trim();
  const branch = String(body.branch || "").trim(); // which branch's sheet this row came from
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (!rowId) return res.json({ success: false, error: "rowId is required" }, 400);
  if (Object.keys(data).length === 0) return res.json({ success: false, error: "empty row data" }, 400);

  log(`Meta sheet row received. rowId=${rowId} branch=${branch || "(none)"} keys=${Object.keys(data).join(", ")}`);

  // ── 3. Map only the identity fields; everything else stays in formData ─────
  const name = pick(data, ["first_name", "full_name", "name"]);
  const mobileNumber = normalizePhone(pick(data, ["phone_number", "phone", "mobile", "mobile_number"]));
  const email = pick(data, ["email", "email_address"]);

  const doc = {
    name,
    mobileNumber,
    email,
    branch, // "Chennai" | "Bangalore" | ... — from the source sheet
    contactId: rowId, // the sheet row's Lead ID — dedup key
    source: "meta",
    // Whole sheet row as one JSON string (campaign, ad set, city and all the
    // what/when questions); the Leads UI parses it and shows the filled fields.
    formData: safeStringify(data),
  };

  // ── 4. Upsert by rowId ────────────────────────────────────────────────────
  const endpoint =
    process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
  const project = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || "";
  const apiKey = process.env.APPWRITE_API_KEY || req.headers["x-appwrite-key"] || "";
  log(`Appwrite client → endpoint=${endpoint} project=${project ? "set" : "MISSING"} apiKey=${apiKey ? "set" : "MISSING"}`);
  const client = new Client().setEndpoint(endpoint).setProject(project).setKey(apiKey);
  const databases = new Databases(client);
  const DB = process.env.APPWRITE_DATABASE_ID;
  const COLLECTION = process.env.META_LEADS_COLLECTION_ID;
  const REQUESTS = process.env.REQUESTS_COLLECTION_ID;

  try {
    // If a meta lead already exists for this row, just refresh it — the request
    // was created on the first sync, so don't create a duplicate request.
    const { documents } = await databases.listDocuments(DB, COLLECTION, [
      Query.equal("contactId", rowId),
      Query.limit(1),
    ]);
    if (documents[0]) {
      const updated = await databases.updateDocument(DB, COLLECTION, documents[0].$id, doc);
      log(`Updated meta lead ${updated.$id} for row ${rowId}`);
      return res.json({ success: true, action: "updated", id: updated.$id });
    }

    // First time we see this row → create a bare Request, then the meta lead
    // linked to it (requestDetails relationship = the request's $id/requestId).
    // Salespeople complete + assign the request later from the Requests page.
    let requestId = "";
    if (REQUESTS) {
      try {
        const request = await createBareRequest(databases, DB, REQUESTS, { name, mobileNumber, email, branch, formData: doc.formData }, log);
        requestId = request.$id;
        doc.requestDetails = requestId;
      } catch (e) {
        // A request-creation failure must NOT block the meta lead — create it
        // unlinked so the lead is never lost; it can be converted manually.
        error(`Request auto-create failed (creating meta lead unlinked): ${e.message}`);
      }
    } else {
      error("REQUESTS_COLLECTION_ID not set — creating meta lead without a linked request.");
    }

    const created = await databases.createDocument(DB, COLLECTION, ID.unique(), doc);
    log(`Created meta lead ${created.$id}${requestId ? ` linked to request ${requestId}` : ""} for row ${rowId}`);
    return res.json({ success: true, action: "created", id: created.$id, requestId, name, mobileNumber });
  } catch (e) {
    error(`Appwrite write failed: ${e.message}`);
    return res.json({ success: false, error: `Appwrite write failed: ${e.message}` }, 500);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Mint the next requestId exactly like the web app's generateId(): TODAY's date
// (DDMMYYYY) + the global running number from the latest request's id, +1.
// The web app stores each request with its requestId AS the document $id, so
// the latest request's $id looks like "TO-20092026-000842".
function generateId(lastQueryId) {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const formattedDate = `${day}${month}${year}`;
  const lastQueryNumber = String(lastQueryId || "").split("-")[2];
  const n = Number(lastQueryNumber);
  const incrementNumber = Number.isFinite(n) ? n + 1 : 1;
  const incrementedValue = String(incrementNumber).padStart(6, "0");
  return `TO-${formattedDate}-${incrementedValue}`;
}

// Create a minimal ("bare") Request from a Meta lead. Only identity + form data
// is known; country, travel dates, pax and assignee are left blank for sales to
// fill via the Requests page Update popup. The doc id IS the requestId (matching
// the web app's addRequest), and we retry on the rare id collision.
async function createBareRequest(databases, DB, REQUESTS, lead, log) {
  const buildPayload = (requestId) => {
    const now = new Date().toISOString();
    return {
      status: "New",
      requestType: "survey",
      name: lead.name,
      phoneNumber: lead.mobileNumber,
      userId: "META", // Request From marker
      email: lead.email,
      countries: [],
      requestDate: now,
      requestId,
      isItineraryConfirmed: false,
      isCorporateBooking: false,
      surveyDetails: JSON.stringify({ cities: {}, country: {}, experiences: {} }),
      // Required fields — seeded with placeholders the salesperson overwrites in
      // the Requests page Update popup (its validation forces real values).
      travellersType: "Couples",
      onwardDate: now,
      returnDate: now,
      travellerMetaData: JSON.stringify({ departureCity: "", adults: 0, childrens: 0 }),
      // Which Meta branch/sheet this lead came from (Chennai / Bangalore / …),
      // so the request can be identified by source branch.
      metaLeadBranch: lead.branch || "",
      metaLeadFormData: lead.formData,
    };
  };

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { documents } = await databases.listDocuments(DB, REQUESTS, [
      Query.limit(1),
      Query.orderDesc("$createdAt"),
    ]);
    const requestId = generateId(documents[0]?.$id);
    try {
      const created = await databases.createDocument(DB, REQUESTS, requestId, buildPayload(requestId));
      log(`Created request ${requestId} from meta lead`);
      return created;
    } catch (e) {
      lastErr = e;
      const dup = String(e.code) === "409" || /already exists|document_already_exists/i.test(e.message || "");
      if (!dup) throw e;
      log(`requestId ${requestId} collided, retrying (${attempt + 1})`);
    }
  }
  throw new Error(`Could not allocate a unique requestId: ${lastErr && lastErr.message}`);
}

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
