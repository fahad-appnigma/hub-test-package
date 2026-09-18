'use strict';

/**
 * hub-test — Closed Won ➝ Salesbricks standalone invoice
 * ======================================================
 *
 * This file is the source of the HubSpot workflow **custom-coded action** that
 * runs when a deal enters the `closedwon` stage. It is deliberately a single
 * self-contained file with no imports beyond the Node runtime, because a
 * HubSpot custom code action is authored as one file: paste this file into the
 * action's code editor (Node.js 20.x runtime) exactly as-is.
 *
 * Workflow contract
 * -----------------
 *   Enrollment trigger : Deal stage is `closedwon` (default sales pipeline),
 *                        re-enrollment OFF.
 *   Action inputs      : dealname, amount, closedate, deal_currency_code,
 *                        associated_company_id, hs_object_id
 *   Secrets            : SALESBRICKS_API_KEY, HUBSPOT_ACCESS_TOKEN
 *   Outputs            : salesbricksInvoiceId, salesbricksInvoiceStatus,
 *                        salesbricksInvoiceNumber, currencyWarning
 *
 * Failure model: every skip/failure writes the reason to the deal property
 * `salesbricks_invoice_status` and then throws, so the workflow marks the
 * action as failed and HubSpot's action-failure notification reaches the
 * designated internal owner. No invoice is ever created on a skip path.
 *
 * See docs/SETUP.md in this repository for the portal-side configuration.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const SALESBRICKS_BASE_URL = 'https://api.salesbricks.com/api/v2';

/** Currencies Salesbricks accepts on an invoice (OpenAPI `InvoiceCreateInput.currency`). */
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR'];
const DEFAULT_CURRENCY = 'USD';

/** Net-30 terms: due date is the close date plus this many days. */
const PAYMENT_TERMS_DAYS = 30;

/** Values written to the deal property `salesbricks_invoice_status`. */
const STATUS = {
  CREATED: 'CREATED',
  MISSING_CUSTOMER_ID: 'MISSING_CUSTOMER_ID',
  MISSING_CONTACT_EMAIL: 'MISSING_CONTACT_EMAIL',
  API_ERROR: 'API_ERROR',
};

const DEAL_PROPERTY_INVOICE_ID = 'salesbricks_invoice_id';
const DEAL_PROPERTY_INVOICE_STATUS = 'salesbricks_invoice_status';
const COMPANY_PROPERTY_CUSTOMER_ID = 'salesbricks_customer_id';

/** `invoice_memo` is capped at 2,000 characters by the Salesbricks schema. */
const INVOICE_MEMO_MAX_LENGTH = 2000;

const REQUEST_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure that has already been recorded on the deal. `status` is the value
 * written to `salesbricks_invoice_status`; `retryable` marks the transient
 * cases HubSpot should retry (Salesbricks 5xx / network).
 */
class ActionError extends Error {
  constructor(message, { status, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'ActionError';
    this.status = status || null;
    this.retryable = retryable;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(level, event, data = {}) {
  const line = { level, event, ...data };
  if (level === 'error') console.error(JSON.stringify(line));
  else if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (!isBlank(value)) return String(value).trim();
  }
  return null;
}

/** Parse a HubSpot money value ("1250.50", 1250.5) into a Number, or null. */
function toNumber(value) {
  if (isBlank(value)) return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Salesbricks reports and accepts money in minor currency units (integers),
 * while HubSpot carries major units as decimals. 1250.5 ➝ 125050.
 */
function toMinorUnits(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed * 100);
}

/**
 * Normalise a HubSpot date (`closedate` is an ISO-8601 timestamp or an epoch
 * milliseconds string) to the `YYYY-MM-DD` form the invoice API expects.
 */
function toIsoDate(value) {
  if (isBlank(value)) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function truncate(value, maxLength) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/**
 * Resolve the currency for the invoice. Anything Salesbricks does not support
 * — including an empty HubSpot value — falls back to USD, and the fallback is
 * reported so the caller can log it and surface it as an action output.
 */
function resolveCurrency(dealCurrencyCode) {
  if (isBlank(dealCurrencyCode)) {
    return { currency: DEFAULT_CURRENCY, warning: null };
  }
  const code = String(dealCurrencyCode).trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.includes(code)) {
    return { currency: code, warning: null };
  }
  return {
    currency: DEFAULT_CURRENCY,
    warning: `Deal currency ${code} is not supported by Salesbricks; invoiced in ${DEFAULT_CURRENCY}.`,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * `fetch` with a timeout, returning a plain result object instead of throwing,
 * so that every caller handles transport failure the same way it handles an
 * HTTP error status.
 */
async function httpRequest(url, options = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = text;
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HubSpot client
// ---------------------------------------------------------------------------

/**
 * The access token used for the CRM reads and the write-back.
 *
 * HubSpot injects workflow secrets as environment variables; a custom code
 * action has no ambient OAuth token of its own, so the portal stores the app's
 * token as the `HUBSPOT_ACCESS_TOKEN` secret. `PRIVATE_APP_ACCESS_TOKEN` is
 * accepted as well because that is the reserved name inside app functions.
 */
function hubspotToken() {
  return firstNonBlank(
    process.env.HUBSPOT_ACCESS_TOKEN,
    process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    process.env.PRIVATE_APP_ACCESS_TOKEN,
  );
}

async function hubspotRequest(path, { method = 'GET', body = null } = {}) {
  const token = hubspotToken();
  if (!token) {
    throw new ActionError('HubSpot access token secret is not configured', {
      status: STATUS.API_ERROR,
    });
  }
  const result = await httpRequest(`${HUBSPOT_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!result.ok) {
    log('error', 'hubspot_request_failed', {
      path,
      method,
      status: result.status,
      response: result.body,
      error: result.error,
    });
  }
  return result;
}

async function getDeal(dealId, properties) {
  const query = `properties=${properties.map(encodeURIComponent).join(',')}`;
  return hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?${query}`);
}

async function getCompany(companyId, properties) {
  const query = `properties=${properties.map(encodeURIComponent).join(',')}`;
  return hubspotRequest(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}?${query}`);
}

async function listAssociations(fromObjectType, objectId, toObjectType) {
  return hubspotRequest(
    `/crm/v4/objects/${fromObjectType}/${encodeURIComponent(objectId)}/associations/${toObjectType}?limit=100`,
  );
}

async function batchReadObjects(objectType, ids, properties) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/batch/read`, {
    method: 'POST',
    body: { properties, inputs: ids.map((id) => ({ id: String(id) })) },
  });
}

async function updateDeal(dealId, properties) {
  return hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: 'PATCH',
    body: { properties },
  });
}

/**
 * Best-effort status write-back. A failure here must not mask the original
 * problem, so it is logged and swallowed.
 */
async function writeStatus(dealId, properties) {
  const result = await updateDeal(dealId, properties);
  if (!result.ok) {
    log('error', 'status_writeback_failed', { dealId, properties, status: result.status });
  }
  return result.ok;
}

// ---------------------------------------------------------------------------
// Resolution steps
// ---------------------------------------------------------------------------

/**
 * An association row is "primary" when HubSpot labels it as such — that is the
 * contact the deal's accounts-payable email is read from.
 */
function isPrimaryAssociation(row) {
  const types = (row && row.associationTypes) || [];
  return types.some((type) => typeof type.label === 'string' && /primary/i.test(type.label));
}

function associationIds(body) {
  const rows = (body && body.results) || [];
  return rows
    .map((row) => firstNonBlank(row.toObjectId, row.id))
    .filter((id) => id !== null);
}

/**
 * Ordered contact ids for the deal, primary association first.
 */
function orderedContactIds(body) {
  const rows = (body && body.results) || [];
  const primary = rows.filter(isPrimaryAssociation);
  const rest = rows.filter((row) => !isPrimaryAssociation(row));
  return [...primary, ...rest]
    .map((row) => firstNonBlank(row.toObjectId, row.id))
    .filter((id) => id !== null);
}

/**
 * Resolve the Salesbricks customer id from the deal's associated company.
 *
 * There is intentionally no name-based fallback: a fuzzy match could invoice
 * the wrong customer, so a missing id is a hard stop.
 */
async function resolveCustomerId(dealId, associatedCompanyId) {
  let companyId = firstNonBlank(associatedCompanyId);

  if (!companyId) {
    const associations = await listAssociations('deals', dealId, 'companies');
    if (!associations.ok) {
      throw new ActionError('Failed to read deal ➝ company associations', {
        status: STATUS.API_ERROR,
        details: associations.body,
      });
    }
    companyId = associationIds(associations.body)[0] || null;
  }

  if (!companyId) {
    throw new ActionError('Deal has no associated company', {
      status: STATUS.MISSING_CUSTOMER_ID,
    });
  }

  const company = await getCompany(companyId, [COMPANY_PROPERTY_CUSTOMER_ID, 'name']);
  if (!company.ok) {
    if (company.status === 404) {
      throw new ActionError(`Associated company ${companyId} was not found`, {
        status: STATUS.MISSING_CUSTOMER_ID,
      });
    }
    throw new ActionError('Failed to read the associated company', {
      status: STATUS.API_ERROR,
      details: company.body,
    });
  }

  const customerId = firstNonBlank(
    company.body && company.body.properties && company.body.properties[COMPANY_PROPERTY_CUSTOMER_ID],
  );
  if (!customerId) {
    throw new ActionError(
      `Company ${companyId} has no ${COMPANY_PROPERTY_CUSTOMER_ID}`,
      { status: STATUS.MISSING_CUSTOMER_ID },
    );
  }

  return { companyId: String(companyId), customerId };
}

/**
 * Resolve the accounts-payable email from the deal's primary contact.
 */
async function resolveAccountsPayableEmail(dealId) {
  const associations = await listAssociations('deals', dealId, 'contacts');
  if (!associations.ok) {
    throw new ActionError('Failed to read deal ➝ contact associations', {
      status: STATUS.API_ERROR,
      details: associations.body,
    });
  }

  const contactIds = orderedContactIds(associations.body);
  if (contactIds.length === 0) {
    throw new ActionError('Deal has no associated contact', {
      status: STATUS.MISSING_CONTACT_EMAIL,
    });
  }

  const contacts = await batchReadObjects('contacts', contactIds, ['email']);
  if (!contacts.ok) {
    throw new ActionError('Failed to read the associated contacts', {
      status: STATUS.API_ERROR,
      details: contacts.body,
    });
  }

  const byId = new Map(
    ((contacts.body && contacts.body.results) || []).map((contact) => [String(contact.id), contact]),
  );
  // Preserve association order so the primary contact wins.
  const primaryId = contactIds[0];
  const primaryEmail = firstNonBlank(
    byId.get(String(primaryId)) &&
      byId.get(String(primaryId)).properties &&
      byId.get(String(primaryId)).properties.email,
  );
  if (!primaryEmail) {
    throw new ActionError(`Primary contact ${primaryId} has no email address`, {
      status: STATUS.MISSING_CONTACT_EMAIL,
    });
  }

  return { contactId: String(primaryId), email: primaryEmail };
}

/**
 * Build the invoice lines from the deal's associated HubSpot line items, or
 * from the deal total when the deal carries no line items.
 *
 * Amounts are minor currency units, matching how Salesbricks reports money.
 */
async function buildLineItems(dealId, { dealName, dealAmount }) {
  const associations = await listAssociations('deals', dealId, 'line_items');
  if (!associations.ok) {
    throw new ActionError('Failed to read deal ➝ line item associations', {
      status: STATUS.API_ERROR,
      details: associations.body,
    });
  }

  const lineItemIds = associationIds(associations.body);
  if (lineItemIds.length > 0) {
    const lineItems = await batchReadObjects('line_items', lineItemIds, [
      'name',
      'quantity',
      'price',
      'amount',
      'description',
    ]);
    if (!lineItems.ok) {
      throw new ActionError('Failed to read the deal line items', {
        status: STATUS.API_ERROR,
        details: lineItems.body,
      });
    }
    const mapped = mapHubSpotLineItems((lineItems.body && lineItems.body.results) || []);
    if (mapped.length > 0) {
      return { lineItems: mapped, source: 'line_items' };
    }
  }

  // Fallback: one line built from the deal itself.
  const amount = toMinorUnits(dealAmount);
  if (amount === null) {
    throw new ActionError('Deal has neither line items nor an amount to invoice', {
      status: STATUS.API_ERROR,
    });
  }
  return {
    lineItems: [{ name: dealName || 'Closed Won deal', amount }],
    source: 'deal_amount',
  };
}

/**
 * Map HubSpot line items onto Salesbricks invoice lines: `name` is the charge
 * name and the amount is quantity × price (falling back to HubSpot's own
 * computed `amount` when price is absent).
 */
function mapHubSpotLineItems(results) {
  const lines = [];
  for (const item of results) {
    const properties = (item && item.properties) || {};
    const price = toNumber(properties.price);
    const quantityValue = toNumber(properties.quantity);
    const quantity = quantityValue === null ? 1 : quantityValue;

    let amount = null;
    if (price !== null) amount = toMinorUnits(price * quantity);
    if (amount === null) amount = toMinorUnits(properties.amount);
    if (amount === null) continue;

    const line = {
      name: firstNonBlank(properties.name) || 'Line item',
      amount,
    };
    const description = firstNonBlank(properties.description);
    if (description) line.description = description;
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Salesbricks client
// ---------------------------------------------------------------------------

function salesbricksApiKey() {
  return firstNonBlank(process.env.SALESBRICKS_API_KEY, process.env.SALESBRICKS_API_TOKEN);
}

/**
 * The OpenAPI schema types `InvoiceCreateInput.line_items` as a plain string
 * even though the field carries a list of charges, so the exact wire format is
 * ambiguous (see README "Known platform gaps"). The request is therefore sent
 * with the structured array first and retried once with the same array
 * JSON-encoded as a string if — and only if — Salesbricks rejects the payload
 * specifically because of `line_items`.
 */
function invoicePayload(base, lineItems, encodeLineItemsAsString) {
  return {
    ...base,
    line_items: encodeLineItemsAsString ? JSON.stringify(lineItems) : lineItems,
  };
}

function rejectsLineItemsFormat(status, body) {
  if (status !== 400) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  return /line_items/i.test(text);
}

/**
 * Pull the invoice id out of a 409 body. Salesbricks does not document the
 * conflict shape, so every plausible location is checked before giving up.
 */
function invoiceIdFromConflict(body) {
  if (!body || typeof body !== 'object') return null;
  return firstNonBlank(
    body.invoice_id,
    body.invoiceId,
    body.invoice && body.invoice.invoice_id,
    body.error && body.error.invoice_id,
    body.error && body.error.details && body.error.details.invoice_id,
  );
}

/**
 * POST /invoices.
 *
 * @returns {{invoiceId: string|null, invoiceNumber: string|null, conflict: boolean}}
 */
async function createSalesbricksInvoice(base, lineItems, { idempotencyKey }) {
  const apiKey = salesbricksApiKey();
  if (!apiKey) {
    throw new ActionError('SALESBRICKS_API_KEY secret is not configured', {
      status: STATUS.API_ERROR,
    });
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-SALESBRICKS-KEY': apiKey,
  };
  if (idempotencyKey) {
    // Guards against duplicate invoices when HubSpot retries the action.
    headers['Idempotency-Key'] = String(idempotencyKey);
  }

  let encodeLineItemsAsString = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const payload = invoicePayload(base, lineItems, encodeLineItemsAsString);
    const result = await httpRequest(`${SALESBRICKS_BASE_URL}/invoices`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (result.ok) {
      const body = result.body || {};
      log('info', 'salesbricks_invoice_created', {
        invoiceId: body.invoice_id,
        invoiceNumber: body.invoice_number,
        lineItemsEncoding: encodeLineItemsAsString ? 'json_string' : 'array',
      });
      return {
        invoiceId: firstNonBlank(body.invoice_id),
        invoiceNumber: firstNonBlank(body.invoice_number),
        conflict: false,
      };
    }

    // 409 — the invoice already exists from an earlier attempt. That is the
    // idempotency guarantee doing its job, so it counts as success.
    if (result.status === 409) {
      const existingId = invoiceIdFromConflict(result.body);
      log('info', 'salesbricks_invoice_conflict', { invoiceId: existingId });
      return { invoiceId: existingId, invoiceNumber: null, conflict: true };
    }

    if (attempt === 1 && rejectsLineItemsFormat(result.status, result.body)) {
      log('warn', 'salesbricks_line_items_format_retry', { response: result.body });
      encodeLineItemsAsString = true;
      continue;
    }

    // Transport failures and 5xx are transient: let HubSpot retry the action
    // rather than marking the deal as a permanent API error.
    const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
    log('error', 'salesbricks_invoice_failed', {
      status: result.status,
      response: result.body,
      error: result.error,
      retryable,
    });
    throw new ActionError(`Salesbricks invoice creation failed (HTTP ${result.status})`, {
      status: retryable ? null : STATUS.API_ERROR,
      retryable,
      details: result.body,
    });
  }

  /* c8 ignore next */
  throw new ActionError('Salesbricks invoice creation failed', { status: STATUS.API_ERROR });
}

// ---------------------------------------------------------------------------
// Action entry point
// ---------------------------------------------------------------------------

function readInputs(event) {
  const inputFields = (event && event.inputFields) || {};
  const objectId = event && event.object && event.object.objectId;
  return {
    dealId: firstNonBlank(inputFields.hs_object_id, objectId),
    dealName: firstNonBlank(inputFields.dealname),
    amount: inputFields.amount,
    closeDate: inputFields.closedate,
    currencyCode: inputFields.deal_currency_code,
    associatedCompanyId: firstNonBlank(inputFields.associated_company_id),
  };
}

async function run(event) {
  const inputs = readInputs(event);
  if (!inputs.dealId) {
    throw new ActionError('Workflow event carried no deal id', { status: null });
  }
  log('info', 'action_started', { dealId: inputs.dealId });

  // Idempotency, first line of defence: a deal that already carries an invoice
  // id is never invoiced twice, no matter how the action is re-run.
  const existing = await getDeal(inputs.dealId, [
    DEAL_PROPERTY_INVOICE_ID,
    DEAL_PROPERTY_INVOICE_STATUS,
  ]);
  if (existing.ok) {
    const existingId = firstNonBlank(
      existing.body && existing.body.properties && existing.body.properties[DEAL_PROPERTY_INVOICE_ID],
    );
    if (existingId) {
      log('info', 'invoice_already_exists', { dealId: inputs.dealId, invoiceId: existingId });
      return {
        salesbricksInvoiceId: existingId,
        salesbricksInvoiceStatus: STATUS.CREATED,
        salesbricksInvoiceNumber: null,
        currencyWarning: null,
        skipped: 'already_invoiced',
      };
    }
  }

  const { companyId, customerId } = await resolveCustomerId(inputs.dealId, inputs.associatedCompanyId);
  const { contactId, email } = await resolveAccountsPayableEmail(inputs.dealId);
  const { lineItems, source } = await buildLineItems(inputs.dealId, {
    dealName: inputs.dealName,
    dealAmount: inputs.amount,
  });

  const issuedAt = toIsoDate(inputs.closeDate) || todayIsoDate();
  const dueAt = addDays(issuedAt, PAYMENT_TERMS_DAYS);
  const { currency, warning } = resolveCurrency(inputs.currencyCode);
  if (warning) log('warn', 'currency_fallback', { dealId: inputs.dealId, warning });

  const base = {
    customer_id: customerId,
    issued_at: issuedAt,
    due_at: dueAt,
    currency,
    send_invoice: false, // held for manual review
    accounts_payable_emails: [email],
    metadata: { hubspot_deal_id: String(inputs.dealId) },
  };
  const memo = truncate(inputs.dealName, INVOICE_MEMO_MAX_LENGTH);
  if (memo) base.invoice_memo = memo;

  log('info', 'invoice_request_prepared', {
    dealId: inputs.dealId,
    companyId,
    contactId,
    customerId,
    currency,
    issuedAt,
    dueAt,
    lineItemCount: lineItems.length,
    lineItemSource: source,
  });

  const invoice = await createSalesbricksInvoice(base, lineItems, {
    idempotencyKey: inputs.dealId,
  });

  const properties = { [DEAL_PROPERTY_INVOICE_STATUS]: STATUS.CREATED };
  if (invoice.invoiceId) properties[DEAL_PROPERTY_INVOICE_ID] = invoice.invoiceId;
  await writeStatus(inputs.dealId, properties);

  return {
    salesbricksInvoiceId: invoice.invoiceId,
    salesbricksInvoiceStatus: STATUS.CREATED,
    salesbricksInvoiceNumber: invoice.invoiceNumber,
    currencyWarning: warning,
    conflict: invoice.conflict || false,
  };
}

/**
 * HubSpot custom code action entry point. Supports both the callback style and
 * the async return style of the workflows runtime.
 *
 * On any skip or failure the reason is written to the deal and the error is
 * re-thrown, which fails the action and triggers the workflow's action-failure
 * notification.
 */
exports.main = async (event = {}, callback) => {
  try {
    const outputFields = await run(event);
    if (typeof callback === 'function') callback({ outputFields });
    return { outputFields };
  } catch (error) {
    const dealId = readInputs(event).dealId;
    const status = error instanceof ActionError ? error.status : STATUS.API_ERROR;
    log('error', 'action_failed', {
      dealId,
      status,
      retryable: error instanceof ActionError ? error.retryable : false,
      message: error.message,
      details: error instanceof ActionError ? error.details : null,
    });
    if (dealId && status) {
      await writeStatus(dealId, { [DEAL_PROPERTY_INVOICE_STATUS]: status });
    }
    // Fails the workflow action so HubSpot notifies the configured owner.
    throw error;
  }
};

// Exported for the unit tests; the workflow runtime only calls `main`.
module.exports.__internals = {
  ActionError,
  STATUS,
  SUPPORTED_CURRENCIES,
  addDays,
  buildLineItems,
  createSalesbricksInvoice,
  invoiceIdFromConflict,
  mapHubSpotLineItems,
  orderedContactIds,
  readInputs,
  rejectsLineItemsFormat,
  resolveAccountsPayableEmail,
  resolveCurrency,
  resolveCustomerId,
  run,
  toIsoDate,
  toMinorUnits,
  truncate,
};
