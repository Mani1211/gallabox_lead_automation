import { Client, Databases, ID } from "node-appwrite";

/**
 * Gallabox webhook → Gallabox lead.
 *
 * Flow:
 *   1. Gallabox chatbot finishes a conversation and POSTs a webhook here.
 *   2. The webhook carries a contactId + the chat data (but NOT the name/number).
 *   3. We call the Gallabox API with that contactId to fetch name + phone.
 *   4. We create a "gallabox lead" document in Appwrite.
 *
 * Configure these environment variables on the Appwrite Function:
 *   GALLABOX_API_KEY               – Gallabox API key    (Settings → API key & secret)
 *   GALLABOX_API_SECRET            – Gallabox API secret
 *   GALLABOX_ACCOUNT_ID            – your Gallabox account id (appears in the contacts URL)
 *   APPWRITE_DATABASE_ID           – target database id
 *   GALLABOX_LEADS_COLLECTION_ID   – target collection id for gallabox leads
 *   APPWRITE_API_KEY               – (optional) server API key. If omitted, the function
 *                                    uses the dynamic key Appwrite injects as `x-appwrite-key`.
 *
 * Appwrite injects APPWRITE_FUNCTION_API_ENDPOINT and APPWRITE_FUNCTION_PROJECT_ID
 * automatically at runtime.
 */

const GALLABOX_BASE = "https://server.gallabox.com/devapi";

export default async ({ req, res, log, error }) => {
  // ── 1. Parse the incoming webhook body ────────────────────────────────────
  let body = {};
  try {
    body = req.bodyJson ?? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {});
  } catch (e) {
    error(`Could not parse webhook body as JSON: ${e.message}`);
    body = {};
  }
  log(`Gallabox webhook received. Top-level keys: ${Object.keys(body || {}).join(", ") || "(none)"}`);

  // ── 2. Pull the contactId + chat data out of the payload ──────────────────
  //     NOTE: field paths below are defensive guesses across common Gallabox
  //     shapes. Once we confirm the real sample payload, tighten extractLead().
  const extracted = extractFromWebhook(body);
  log(`Extracted contactId=${extracted.contactId || "(none)"} channel=${extracted.channel || "(unknown)"}`);

  if (!extracted.contactId) {
    error("No contactId found in webhook payload — cannot fetch contact. Storing nothing.");
    return res.json(
      { success: false, error: "contactId missing from webhook payload", receivedKeys: Object.keys(body || {}) },
      400
    );
  }

  // ── 3. Fetch the contact (name + number) from the Gallabox API ────────────
  let contact = null;
  try {
    contact = await fetchGallaboxContact(extracted.contactId, log);
  } catch (e) {
    error(`Gallabox contact fetch failed: ${e.message}`);
    return res.json({ success: false, error: `Gallabox contact fetch failed: ${e.message}` }, 502);
  }

  const name = pickName(contact) || extracted.name || "";
  const mobileNumber = normalizePhone(pickPhone(contact) || extracted.mobileNumber || "");
  const email = pickEmail(contact) || extracted.email || "";
  log(`Resolved contact: name="${name}" mobile="${mobileNumber}"`);

  // ── 4. Create the Gallabox lead document in Appwrite ──────────────────────
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY || req.headers["x-appwrite-key"] || "");
  const databases = new Databases(client);

  const channel = extracted.channel || pickChannel(contact) || "";

  const doc = {
    name,
    mobileNumber,
    email,
    channel,
    contactId: extracted.contactId,
    conversationId: extracted.conversationId || "",
    botId: extracted.botId || "",
    flowId: extracted.flowId || "",
    botSessionId: extracted.botSessionId || "",
    chatSummary: extracted.chatSummary || "",
    goalAchieved: extracted.goalAchieved || false,
    // Whole extracted map stored as a JSON string; the Leads UI parses it and
    // iterates over whatever keys are present (they vary per flow).
    extractedData: safeStringify(extracted.extractedData),
  };

  try {
    const created = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.GALLABOX_LEADS_COLLECTION_ID,
      ID.unique(),
      doc
    );
    log(`Created gallabox lead ${created.$id} for contact ${extracted.contactId}`);
    return res.json({ success: true, id: created.$id, name, mobileNumber });
  } catch (e) {
    error(`Failed to create gallabox lead document: ${e.message}`);
    return res.json({ success: false, error: `Appwrite createDocument failed: ${e.message}` }, 500);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the fields we care about from the Gallabox bot webhook.
 *
 * Real payload shape (bot session-complete):
 *   { botId, flowId, botSessionId, conversationId, contactId,
 *     extractedData: { destination, "Travel Date_Month", Number_of_Travellers,
 *                      Departure_City, Trip_Duration, Budget, ... },
 *     eligibilityResults: [
 *       { insightDefinitionId: "SESSION_SUMMARY_ID", value: "<summary text>" },
 *       { insightDefinitionId: "SESSION_GOAL_ACHIEVED_ID", value: true }, ...
 *     ] }
 */
function extractFromWebhook(body) {
  const b = body || {};
  const contactId = b.contactId || b?.contact?.id || "";
  const conversationId = b.conversationId || "";
  const botId = b.botId || "";
  const flowId = b.flowId || "";
  const botSessionId = b.botSessionId || "";

  // Structured trip details the bot collected. Keys vary per flow and not all
  // are always present, so we store the whole object as-is (stringified on write)
  // and let the Leads UI parse + iterate over whatever keys exist.
  const extractedData = b.extractedData && typeof b.extractedData === "object" ? b.extractedData : {};

  // Summary + goal live in eligibilityResults, keyed by insightDefinitionId.
  const results = Array.isArray(b.eligibilityResults) ? b.eligibilityResults : [];
  const summaryRow = results.find((r) => r?.insightDefinitionId === "SESSION_SUMMARY_ID");
  const goalRow = results.find((r) => r?.insightDefinitionId === "SESSION_GOAL_ACHIEVED_ID");
  const chatSummary = typeof summaryRow?.value === "string" ? summaryRow.value : summaryRow?.reason || "";
  const goalAchieved = goalRow ? Boolean(goalRow.value ?? goalRow.result) : false;

  // channel isn't on the bot webhook; resolved from the contact API if present.
  const channel = "";

  return {
    contactId,
    conversationId,
    botId,
    flowId,
    botSessionId,
    channel,
    extractedData,
    chatSummary,
    goalAchieved,
    // name / number are NOT on the bot webhook — the contact API is the source.
    name: "",
    mobileNumber: "",
    email: "",
  };
}

async function fetchGallaboxContact(contactId, log) {
  const accountId = process.env.GALLABOX_ACCOUNT_ID;
  const apiKey = process.env.GALLABOX_API_KEY;
  const apiSecret = process.env.GALLABOX_API_SECRET;
  if (!accountId || !apiKey || !apiSecret) {
    throw new Error("Missing GALLABOX_ACCOUNT_ID / GALLABOX_API_KEY / GALLABOX_API_SECRET env vars");
  }

  const url = `${GALLABOX_BASE}/accounts/${accountId}/contacts/${contactId}`;
  log(`Fetching Gallabox contact: ${url}`);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      apiKey: apiKey,
      apiSecret: apiSecret,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${text.slice(0, 300)}`);
  }
  return await resp.json();
}

// Contact-response field pickers (defensive — Gallabox returns arrays for phone/email).
function pickName(contact) {
  if (!contact) return "";
  return contact.name || contact.fullName || contact?.contact?.name || "";
}

function pickPhone(contact) {
  if (!contact) return "";
  const p = contact.phone ?? contact.phoneNumbers ?? contact.mobileNumber ?? contact?.contact?.phone;
  if (!p) return "";
  if (Array.isArray(p)) {
    const first = p[0];
    if (!first) return "";
    return typeof first === "string" ? first : first.phoneNumber || first.value || first.number || "";
  }
  return typeof p === "string" ? p : p.phoneNumber || p.value || "";
}

// Country calling codes we recognise, so we strip the exact dialing code and
// keep the correct local number for any country (not just a blind 10-digit
// chop). Longest codes are matched first (e.g. "971" before "91"/"9").
const COUNTRY_CODES = [
  "1", // US / Canada
  "7", // Russia / Kazakhstan
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58",
  "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218",
  "230", "248", "249",
  "351", "352", "353", "354", "355", "356", "357", "358", "359",
  "852", "853", "855", "856",
  "880", "886",
  "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975", "976", "977",
  "992", "993", "994", "995", "996", "998",
];

// Store just the local number, without the country/dialing code. Strips all
// formatting, removes an international prefix ("+" / "00"), then removes a
// recognised country code. Falls back to keeping the last 10 digits.
// "+91 98765 43210" -> "9876543210"; "+971 50 123 4567" -> "501234567".
function normalizePhone(raw) {
  if (!raw) return "";
  const hadIntlPrefix = /^\s*(\+|00)/.test(String(raw));
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);

  // A bare number with no international prefix is already the local number.
  if (!hadIntlPrefix && digits.length <= 10) return digits;

  // Strip a recognised country code (longest first) when the remaining local
  // number is a plausible length.
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (digits.startsWith(code)) {
      const local = digits.slice(code.length);
      if (local.length >= 6 && local.length <= 11) return local;
    }
  }

  // Fallback: keep the last 10 digits.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function pickEmail(contact) {
  if (!contact) return "";
  const e = contact.email ?? contact.emails ?? contact?.contact?.email;
  if (!e) return "";
  if (Array.isArray(e)) {
    const first = e[0];
    if (!first) return "";
    return typeof first === "string" ? first : first.email || first.value || "";
  }
  return typeof e === "string" ? e : e.email || e.value || "";
}

function pickChannel(contact) {
  if (!contact) return "";
  const c = contact.channel || contact.lastChannel || contact?.contact?.channel || "";
  return typeof c === "string" ? c.toLowerCase() : "";
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
