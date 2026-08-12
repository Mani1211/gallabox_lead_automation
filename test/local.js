/**
 * Local runner for the Gallabox webhook Appwrite Function.
 *
 * Usage:
 *   1. cp .env.example .env   and fill in the values
 *   2. npm install
 *   3. npm run test:local                 # uses the built-in sample payload
 *      npm run test:local -- <contactId>  # override the contactId with a real one
 *
 * It builds a mock Appwrite function context (req/res/log/error), loads .env,
 * and invokes src/main.js exactly like the Appwrite runtime would — so a green
 * run here means the deployed function will behave the same.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import handler from "../src/main.js";

const here = dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no dependency) ─────────────────────────────────────────
try {
  const raw = readFileSync(join(here, "..", ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2].replace(/^['"]|['"]$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
  console.log("Loaded .env");
} catch {
  console.log("No .env file found — relying on the shell environment.");
}

// Appwrite injects these two at runtime; map them from local-friendly names.
process.env.APPWRITE_FUNCTION_API_ENDPOINT ||=
  process.env.APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
process.env.APPWRITE_FUNCTION_PROJECT_ID ||= process.env.APPWRITE_PROJECT_ID || "";

// ── sample webhook payload (real Gallabox bot session-complete shape) ────────
const sample = {
  botId: "69e852158174cf1c5fdece93",
  flowId: "69e852158174cf1c5fdece9d",
  botSessionId: "6a7960885573ad1ebeaf660d",
  conversationId: "6a79608832e95c27b17a983a",
  contactId: process.argv[2] || "68ef745e87408c5e41b11f43",
  extractedData: {
    destination: "Dubai",
    "Travel Date_Month": "October 12, 2026",
    Number_of_Travellers: "2 Adults",
    Departure_City: "Chennai",
    Trip_Duration: "15+ days",
    Budget: "₹2,00,000 per person",
  },
  eligibilityResults: [
    {
      insightDefinitionId: "SESSION_SUMMARY_ID",
      result: true,
      value:
        "User plans a 15+ day Dubai trip from Chennai, 2 adults, budget ₹2,00,000 per person.",
    },
    { insightDefinitionId: "SESSION_GOAL_ACHIEVED_ID", result: true, value: true },
  ],
};

// ── mock Appwrite function context ───────────────────────────────────────────
const req = {
  bodyJson: sample,
  body: JSON.stringify(sample),
  bodyRaw: JSON.stringify(sample),
  headers: {},
  method: "POST",
};
let captured;
const res = {
  json: (obj, status = 200) => ((captured = { status, obj }), captured),
  send: (text, status = 200) => ((captured = { status, text }), captured),
  empty: () => ((captured = { status: 204 }), captured),
};
const log = (...a) => console.log("[log]", ...a);
const error = (...a) => console.error("[error]", ...a);

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`\nInvoking function with contactId=${sample.contactId}\n`);
const ret = (await handler({ req, res, log, error })) || captured;
console.log("\n=== RESPONSE ===");
console.log("HTTP status:", ret?.status);
console.log("body:", JSON.stringify(ret?.obj ?? ret?.text ?? null, null, 2));
process.exit(ret?.obj?.success ? 0 : 1);
