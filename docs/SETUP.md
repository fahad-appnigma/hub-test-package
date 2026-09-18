# Setup — Closed Won ➝ Salesbricks invoice

Everything below happens inside HubSpot. There is no external server, queue or
middleware in the data path.

## 1. Custom properties

| Object  | Property                     | Type             | Written by |
| ------- | ---------------------------- | ---------------- | ---------- |
| Company | `salesbricks_customer_id`    | Single-line text | Your team  |
| Deal    | `salesbricks_invoice_id`     | Single-line text | The action |
| Deal    | `salesbricks_invoice_status` | Single-line text | The action |

Create them once per portal:

```bash
HUBSPOT_ACCESS_TOKEN=<token with crm.schemas.*.write> \
  node scripts/create-custom-properties.js
```

The script is idempotent — re-running it reports `exists` and changes nothing.
Add `--dry-run` to see what it would do first.

`salesbricks_customer_id` must be populated on every company you intend to
invoice. A blank value stops the invoice: the action never guesses a customer
by name, because a fuzzy match can invoice the wrong company.

## 2. Secrets

The custom-coded action reads two secrets from the workflow's **Secrets**
panel (*Automation ➝ Workflows ➝ your workflow ➝ the custom code action ➝
Secrets ➝ Add secret*):

| Secret                 | Value                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `SALESBRICKS_API_KEY`  | Salesbricks ➝ Settings ➝ Integrations ➝ Public API. Sent as `X-SALESBRICKS-KEY`. |
| `HUBSPOT_ACCESS_TOKEN` | A HubSpot token with the scopes listed below, used for the CRM reads and the write-back. |

Required HubSpot scopes:

```
crm.objects.deals.read     crm.objects.deals.write
crm.objects.companies.read crm.objects.contacts.read
crm.objects.line_items.read
automation
```

Neither secret ever appears in the code or in this repository.

## 3. Workflow

1. **Automation ➝ Workflows ➝ Create workflow ➝ From scratch**, object type
   **Deal**.
2. Enrollment trigger: **Deal stage** *is any of* **Closed Won**
   (`closedwon` on the default sales pipeline).
3. Leave **re-enrollment off**. Re-enrolment would create a second invoice
   every time a closed deal is edited.
4. Add a **Custom code** action, runtime **Node.js 20.x**, and paste the whole
   of [`workflow/closed-won-invoice/action.js`](../workflow/closed-won-invoice/action.js).
5. Add the property inputs the action expects — the *Property to include in
   code* picker, one row each:

   | Input name              | Deal property           |
   | ----------------------- | ----------------------- |
   | `dealname`              | Deal name               |
   | `amount`                | Amount                  |
   | `closedate`             | Close date              |
   | `deal_currency_code`    | Currency                |
   | `associated_company_id` | Associated company ID   |
   | `hs_object_id`          | Record ID               |

6. Add the data outputs (all **String**): `salesbricksInvoiceId`,
   `salesbricksInvoiceStatus`, `salesbricksInvoiceNumber`, `currencyWarning`.
7. **Settings ➝ Notifications**: turn on *Send an email when an action fails*
   and name the internal owner who should chase missing customer IDs and
   missing contact emails. This notification is how a skipped invoice reaches
   a human.
8. Turn the workflow on.

## 4. What the action does

```
deal enters closedwon
  └─ deal already has salesbricks_invoice_id?      ─ yes ─▶ stop (no duplicate)
  └─ company.salesbricks_customer_id missing?      ─ yes ─▶ MISSING_CUSTOMER_ID, action fails
  └─ primary contact email missing?                ─ yes ─▶ MISSING_CONTACT_EMAIL, action fails
  └─ POST /api/v2/invoices  (send_invoice: false)
       ├─ 2xx ─▶ salesbricks_invoice_id + status CREATED
       ├─ 409 ─▶ already created earlier; id written back, treated as success
       ├─ 4xx ─▶ status API_ERROR, action fails
       └─ 5xx ─▶ action fails without flagging the deal, HubSpot retries
```

Invoices are created with `send_invoice: false`, so nothing reaches the
customer until someone reviews and sends it in Salesbricks.

## 5. Verifying a portal

1. Create a test company with a real `salesbricks_customer_id`, a contact with
   an email, and a deal associated to both with one or two line items.
2. Move the deal to **Closed Won**.
3. Workflow history shows the action succeeded; the deal shows
   `salesbricks_invoice_status = CREATED` and an invoice ID.
4. Salesbricks ➝ Billing shows the draft invoice, unsent, net-30 from the
   close date.
5. Clear both deal properties and blank the company's
   `salesbricks_customer_id`, then re-enrol: the action must fail with
   `MISSING_CUSTOMER_ID` and no invoice must appear in Salesbricks.
