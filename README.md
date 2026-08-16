# Gallabox webhook → Gallabox lead (Appwrite Function)

Receives the webhook Gallabox fires when a chatbot conversation completes,
resolves the contact's **name + number** from the Gallabox API, and writes a
**Gallabox lead** document into Appwrite. The Sales Admin "Gallabox Leads"
section reads from that collection.

```
Gallabox chatbot (WhatsApp / Instagram)
        │  conversation complete
        ▼
  POST webhook  ───────────────►  this Appwrite Function
                                        │  contactId + chat data
                                        │
                                        ├─► GET Gallabox API  /accounts/{accountId}/contacts/{contactId}
                                        │        → name, phone, email
                                        │
                                        └─► Appwrite upsert( gallabox_leads )  [keyed by contactId]
```

## Upsert behaviour (keyed by `contactId`)

`contactId` is the unique identifier. On every webhook:

- **Existing record for this `contactId`** → **update** it. Gallabox re-sends the
  webhook once a contact's number becomes available, and the update refreshes
  the record instead of creating a duplicate.
- **No record + mobile number available** → **create** the lead.
- **No record + no mobile number** → **skip** (returns HTTP 200 with
  `action: "skipped"`). This is an Instagram contact whose number hasn't been
  shared yet; Gallabox resends the webhook once it is, and that resend creates
  the record.

Requires the `contactId` attribute to be **indexed** on the `gallabox_leads`
collection for the lookup query.

## 1. Environment variables (set on the Function → Settings → Variables)

| Variable                       | Purpose                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| `GALLABOX_API_KEY`             | Gallabox API key (Gallabox → Settings → API key & secret)     |
| `GALLABOX_API_SECRET`          | Gallabox API secret                                           |
| `GALLABOX_ACCOUNT_ID`          | Your Gallabox account id (appears in the contacts API URL)    |
| `APPWRITE_DATABASE_ID`         | Target database id (same as the app's `NEXT_PUBLIC_APPWRITE_DATABASE_ID`) |
| `GALLABOX_LEADS_COLLECTION_ID` | Collection id for gallabox leads (see `docs/gallabox-lead-appwrite.md`) |
| `APPWRITE_API_KEY`             | *(optional)* server API key with `documents.write`. If omitted, the function uses the dynamic key Appwrite injects. |

`APPWRITE_FUNCTION_API_ENDPOINT` and `APPWRITE_FUNCTION_PROJECT_ID` are injected
automatically by Appwrite — do not set them.

If you rely on the injected dynamic key instead of `APPWRITE_API_KEY`, enable a
scope for `databases.write` on the function.

## 2. Test locally (before deploying)

Run the function on your machine with a mock Appwrite context. It executes the
real Gallabox contact fetch and the real Appwrite write, so a green run here
means the deployed function will behave identically.

```bash
cp .env.example .env      # then fill in the values
npm install
npm run test:local                    # uses the built-in sample payload
npm run test:local -- <realContactId> # or pass a real contactId to fetch
```

Requires Node 18+. For local runs, set `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`
and `APPWRITE_API_KEY` (a server key with `documents.write`) in `.env` — Appwrite
injects the first two automatically once deployed, but locally there's no runtime
to inject them.

- ✅ Success prints `HTTP status: 200` and `{"success":true,"id":...}` and a new
  doc appears in `gallabox_leads`.
- ❌ Failure prints the failing step + message (same as the deployed function's
  logs) and exits non-zero.

Once it's green locally, commit and push — if the function is Git-connected in
Appwrite, the push auto-deploys; otherwise redeploy from the console/CLI.

## 3. Deploy

- Runtime: **Node.js 18+**
- Entrypoint: `src/main.js`
- Build command: `npm install`
- Execute access: **Any** (Gallabox posts unauthenticated). See the security note below.

Via CLI:

```bash
appwrite functions createDeployment \
  --functionId <FUNCTION_ID> \
  --entrypoint 'src/main.js' \
  --code . \
  --activate true
```

## 4. Point Gallabox at it

Copy the Function's **Domain / execution URL** from the Appwrite console and set
it as the webhook URL in your Gallabox bot's "post to webhook" step.

## 5. Test the deployed function

The webhook is a plain POST — test it with `curl` against the function's public
domain (replace the URL and the payload with a real Gallabox sample):

```bash
curl -X POST https://<your-function-domain>/ \
  -H 'Content-Type: application/json' \
  -d '{
        "botId": "69e852158174cf1c5fdece93",
        "flowId": "69e852158174cf1c5fdece9d",
        "botSessionId": "6a7960885573ad1ebeaf660d",
        "conversationId": "6a79608832e95c27b17a983a",
        "contactId": "PASTE_A_REAL_CONTACT_ID",
        "extractedData": {
          "destination": "Dubai",
          "Travel Date_Month": "October 12, 2026",
          "Number_of_Travellers": "2 Adults",
          "Departure_City": "Chennai",
          "Trip_Duration": "15+ days",
          "Budget": "₹2,00,000 per person"
        },
        "eligibilityResults": [
          { "insightDefinitionId": "SESSION_SUMMARY_ID", "result": true,
            "value": "User plans a 15+ day Dubai trip from Chennai, 2 adults, budget 2L pp." },
          { "insightDefinitionId": "SESSION_GOAL_ACHIEVED_ID", "result": true, "value": true }
        ]
      }'
```

Use a **real `contactId`** so the Gallabox contact fetch (name/number) succeeds.

A success returns `{ "success": true, "id": "...", "name": "...", "mobileNumber": "..." }`.
On any error the function logs the full reason (Function → Executions → Logs) and
returns a JSON error with the right HTTP status. The received top-level keys, the
extracted `contactId`, the Gallabox fetch URL, and the resolved name/number are
all logged, so a failure tells you exactly which step broke.

## Security note (auth deferred by request)

Execute access is currently open so Gallabox can post without credentials. Before
production, add a shared-secret check: have Gallabox send a header (e.g.
`x-gallabox-token`) and reject requests whose token doesn't match an env var.
This is a ~5-line addition when you're ready.

## Field mapping

`extractFromWebhook()` in `src/main.js` maps the webhook payload → lead fields,
finalized against the real bot session-complete payload:

- `contactId`, `conversationId`, `botId`, `flowId`, `botSessionId` — top-level.
- `extractedData` → stored **as one JSON string** (not split into columns), since
  its keys vary per flow and aren't always all present. The Leads UI parses it and
  iterates over whatever keys exist.
- `eligibilityResults` → `chatSummary` (`SESSION_SUMMARY_ID`) and `goalAchieved`
  (`SESSION_GOAL_ACHIEVED_ID`).
- `name` / `mobileNumber` / `email` come from the Gallabox contact API, not the
  webhook.

See `docs/gallabox-lead-appwrite.md` for the full collection schema.
# gallabox_lead_automation
