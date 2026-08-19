# hub-test-package

Private HubSpot app **hub-test**: a read-only *Renewal Summary* card on the Company
record that surfaces two existing company properties — renewal date and renewal
risk — without the team having to hunt through the properties sidebar.

## What it does

| Field | Property (internal name) | Rendering |
| --- | --- | --- |
| Renewal date | `renewal_date` | HubSpot's standard date format for the portal (formatted server-side by HubSpot, no custom formatting in the card) |
| Renewal risk | `renewal_risk` | Colour-coded `Tag` — `Low` → green (`success`), `Medium` → amber (`warning`), `High` → red (`error`) |

If either value is null, empty or blank, the card renders `Not set` in that
field's position. The card always renders: it never hides itself and never
throws on missing data. There are no inputs, buttons or forms — all edits stay
in the standard properties panel.

## Layout

```
src/app/app-hsmeta.json                          app config: private distribution, static auth
src/app/cards/renewal-summary-card-hsmeta.json   card config: COMPANY only, right sidebar
src/app/cards/RenewalSummaryCard.tsx             entrypoint (hubspot.extend)
src/app/cards/RenewalSummary.tsx                 the card UI
tests/RenewalSummary.test.tsx                    unit tests (dev only, not uploaded)
```

Only `src/` is uploaded to HubSpot (`srcDir` in `hsproject.json`). The root
`package.json`, `vitest.config.ts` and `tests/` are a local dev harness.

## Scopes

`crm.objects.companies.read` only (plus the baseline `oauth` scope every app
declares). No write scopes, no other objects, no outbound calls to any external
system — `permittedUrls.fetch` is empty.

## Local checks

```bash
npm install
npm run typecheck   # tsc over card sources and tests
npm test            # vitest, 19 tests
```

## Deploy and install

```bash
hs project upload   # builds the app in the HubSpot developer account
```

Then generate the private install link for **hub-test** from the developer
portal and install it into the customer's portal.

### Post-install step (required)

On platform version `2026.03`, app cards are not auto-placed on a record view.
After installing, someone with edit access has to add the card once:

1. Open any Company record → **Customize** → pick the view/tab.
2. **+ Add card** → filter the card library by **App** → select **Renewal Summary**.
3. Drag it to the top of the right sidebar → **Save**.

The card then appears on every Company record in that view. Card position is
controlled here, not in the manifest — the 2026.03 card config has no
display-order field.

## Implementation note

The card reads the two properties with the `useCrmProperties` hook from
`@hubspot/ui-extensions/crm`. On this platform version that is the supported way
for a card to read CRM properties; there is no `properties` array in the card or
app config that injects property values into `context`. The values still come
from HubSpot itself (no external API, no serverless function), the card stays
read-only, and the properties are read as-is by internal name.
