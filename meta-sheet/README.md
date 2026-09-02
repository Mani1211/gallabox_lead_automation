# Meta Ad Leads — Google Sheet → Appwrite (second Appwrite Function)

Meta/Instagram **lead ads** land as rows in a Google Sheet. A bound **Apps
Script** posts each new row to this function, which upserts a **Meta Ad lead**
in Appwrite. The Sales Admin "Meta Ad Leads" tab reads that collection; sales
convert leads to Requests (same flow as Gallabox Leads).

```
Meta / Instagram lead ad → Google Sheet (row per lead)
        │  Apps Script (5-min trigger, posts unsynced rows)
        ▼
  this function  →  upsert meta_leads (dedup by rowId / "Lead ID")
        ▼
  Sales Admin "Meta Ad Leads" tab → Create Request
```

This is a **separate function** in the same repo — it does **not** affect the
Gallabox function or its URL. Point this function's **root directory** to
`meta-sheet/`; the Gallabox function keeps building from the repo root.

## 1. Appwrite collection `meta_leads`

| Attribute            | Type         | Notes                                              |
| -------------------- | ------------ | -------------------------------------------------- |
| `name`               | string       | from `first_name`                                  |
| `mobileNumber`       | string       | from `phone_number` (country code stripped to local) |
| `email`              | string       | usually empty (Meta phone-only form)               |
| `contactId`          | string       | **indexed** — the sheet row's `Lead ID` (dedup)    |
| `formData`           | string       | large (~20000) — **whole row as one JSON string** (campaign, ad set, city, and every what/when question); UI shows the filled fields |
| `source`             | string       | constant `"meta"`                                  |
| `assignedTo`         | relationship | → Employees (nullable) — assignee dropdown         |
| `requestDetails`     | relationship | → Requests (nullable) — set on Create Request      |

Only the identity fields (`name`, `mobileNumber`, `email`) are separate
columns; everything else — campaign, ad set, city and all the questions — is
kept inside the single `formData` JSON (like Gallabox's `extractedData`).

Index `contactId`. Copy the `assignedTo` / `requestDetails` relationship
settings from `gallabox_leads`.

## 2. Deploy the function

- Appwrite → Functions → **Create function**, Node 18, **root directory `meta-sheet`**,
  entrypoint `src/main.js`, build `npm install`, Execute access **Any**.
- Variables: `META_WEBHOOK_SECRET` (make one up), `APPWRITE_DATABASE_ID`,
  `META_LEADS_COLLECTION_ID`, and `APPWRITE_API_KEY` (or grant the injected key
  `databases.write`).
- Enable a **Domain** — that URL goes into the Apps Script.

## 3. Wire the Google Sheet (`apps-script.gs`)

1. Sheet → **Extensions → Apps Script**, paste `apps-script.gs`.
2. Set `WEBHOOK_URL` (the function domain) and `SECRET` (= `META_WEBHOOK_SECRET`).
   Set `SHEET_NAME` if the tab isn't the first one.
3. Run **`markAllSyncedBaseline()`** once → marks existing rows so only **new**
   rows sync from now on (prevents a mass back-import).
4. Run **`setupTrigger()`** once → installs a 5-minute time trigger.
   (Approve the permissions prompt on first run.)

The script adds two columns it manages: **Lead ID** (stable dedup id) and
**Synced At** (timestamp). It only posts rows that have a `phone_number` and no
`Synced At`.

## Dedup / idempotency

`contactId = rowId = the row's Lead ID`. The function **upserts** on it, and the
sheet's `Synced At` stops re-posting — so no duplicates even if the trigger
overlaps or a row is edited.

## Field mapping

`src/main.js` maps only `first_name → name` and `phone_number → mobileNumber`
(and `email` if present); the **entire row** — campaign, ad set, city and every
what/when question — is kept in the single `formData` JSON. The Leads UI parses
it and renders whatever fields are non-empty.

## Test

```bash
curl -X POST https://YOUR-META-FUNCTION-DOMAIN.appwrite.run/ \
  -H 'Content-Type: application/json' \
  -d '{"secret":"YOUR_SECRET","rowId":"test-row-1","data":{"first_name":"Asha","phone_number":"+91 98765 43210","city":"Chennai","Campaign Name":"Dubai-Oct","Ad Set / Audience":"Lookalike-1%"}}'
```
Success → `{"success":true,"action":"created",...}` and a row in `meta_leads`.
