# hub-test — Closed Won ➝ Salesbricks invoice

A HubSpot app that raises a Salesbricks standalone invoice the moment a deal
reaches **Closed Won** on the default sales pipeline. One-way, HubSpot ➝
Salesbricks; the only thing coming back is the invoice ID and a status written
onto the deal.

Invoices are created held for review (`send_invoice: false`) — your team
decides when the customer sees them.

## Layout

```
src/app/app-hsmeta.json                  the app: OAuth scopes, permitted fetch hosts
workflow/closed-won-invoice/action.js    the custom-coded action (paste into the workflow)
scripts/create-custom-properties.js      provisions the three custom properties
docs/SETUP.md                            portal configuration, step by step
test/                                    unit tests for the action (node --test)
```

The action is a single self-contained file on purpose: a HubSpot custom code
action is authored as one file in the workflow editor, so it carries no
imports beyond the Node 20 runtime.

## Behaviour

| Step | Source                                    | Invoice field                       |
| ---- | ----------------------------------------- | ----------------------------------- |
| 1    | Company `salesbricks_customer_id`         | `customer_id`                       |
| 2    | Deal `closedate`                          | `issued_at`                         |
| 3    | `closedate` + 30 days                     | `due_at`                            |
| 4    | Deal `deal_currency_code` (USD fallback)  | `currency`                          |
| 5    | Deal `dealname` (≤ 2,000 chars)           | `invoice_memo`                      |
| 6    | Deal line items, else the deal `amount`   | `line_items`                        |
| 7    | Primary associated contact's `email`      | `accounts_payable_emails`           |
| 8    | fixed                                     | `send_invoice: false`               |

Outcomes recorded on the deal in `salesbricks_invoice_status`: `CREATED`,
`MISSING_CUSTOMER_ID`, `MISSING_CONTACT_EMAIL`, `API_ERROR`.

Duplicate protection is two-layered: the action refuses to run on a deal that
already carries a `salesbricks_invoice_id`, and the POST sends the deal ID as
an idempotency key so a Salesbricks 409 is treated as success rather than as a
failure.

## Tests

```bash
npm test          # node --test, no dependencies, no network
```

The suite covers the mapping helpers plus the full action against a stubbed
HubSpot and Salesbricks: line-item mapping, the deal-amount fallback, the two
skip paths, currency fallback, 409/4xx/5xx handling and the duplicate guard.

## Known platform gaps

These are the places where the platform contracts are ambiguous and the code
takes a documented position rather than guessing silently.

1. **`line_items` serialisation.** The Salesbricks OpenAPI spec
   (`https://api.salesbricks.com/api/v2/openapi.yaml`) types
   `InvoiceCreateInput.line_items` as a plain `string` while describing it as
   "the line items to be included on the invoice", and publishes no request
   example. `line_item_overrides` on `PATCH /invoices/{id}` is typed the same
   way, which points at a JSON-valued field flattened by the schema
   generator. The action therefore sends the structured array first and, only
   if Salesbricks rejects the request with a 400 that names `line_items`,
   retries once with the identical array JSON-encoded as a string. Line shape
   is `{ name, amount, description? }`, mirroring the charge fields of the
   one-off invoice form (charge name, amount, description).
2. **Money units.** Salesbricks reports money in minor currency units
   (`InvoiceLineItemOutput.tax`, `grand_total`) and takes `InvoiceAdjustment.adjustment`
   as an integer, so amounts are sent as integer minor units (`1250.50` ➝
   `125050`). If a first live invoice comes back 100× off, this is the line to
   change (`toMinorUnits`).
3. **Idempotency key.** Salesbricks documents no idempotency header. The deal
   ID is sent as `Idempotency-Key` (harmless if ignored) and also as
   `metadata.hubspot_deal_id`, and the real duplicate guard is the
   `salesbricks_invoice_id` check on the deal before anything is posted.
4. **Token for the action.** A HubSpot custom code action has no ambient OAuth
   token, so the CRM calls use a token supplied as the `HUBSPOT_ACCESS_TOKEN`
   workflow secret (`PRIVATE_APP_ACCESS_TOKEN` and `HUBSPOT_PRIVATE_APP_TOKEN`
   are accepted as aliases).
5. **Currency fallback reporting.** An unsupported deal currency falls back to
   USD. The warning is logged and returned as the `currencyWarning` output
   rather than written to `salesbricks_invoice_status`, which stays inside its
   four documented values.
6. **Serverless functions vs. OAuth.** Platform version 2026.03 serverless
   functions are only available to privately distributed apps using static
   auth, so the invoice logic lives in the workflow's custom code action
   rather than in an app function. The app itself stays OAuth/marketplace as
   specified.

## Out of scope

Subscription creation, payment-status sync back to HubSpot, deal re-opens and
stage reversals, Salesbricks ➝ HubSpot webhooks, automated invoice sending,
backfilling already-closed deals, and custom pipeline stage IDs.

See [docs/SETUP.md](docs/SETUP.md) to configure a portal.
