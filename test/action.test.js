'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const action = require('../workflow/closed-won-invoice/action');
const { installFetchStub } = require('./helpers/hubspot-stub');

const {
  STATUS,
  addDays,
  invoiceIdFromConflict,
  mapHubSpotLineItems,
  orderedContactIds,
  readInputs,
  rejectsLineItemsFormat,
  resolveCurrency,
  toIsoDate,
  toMinorUnits,
  truncate,
} = action.__internals;

process.env.SALESBRICKS_API_KEY = 'sb-test-key';
process.env.HUBSPOT_ACCESS_TOKEN = 'hs-test-token';

/** A Closed Won deal with a company, a primary contact and two line items. */
function happyWorld(overrides = {}) {
  return {
    deal: { id: '1001', properties: {} },
    companyAssociations: ['2001'],
    companies: { 2001: { salesbricks_customer_id: 'cus-uuid-7', name: 'Acme' } },
    contactAssociations: [
      { id: '3002', associationTypes: [{ label: 'Decision maker' }] },
      { id: '3001', associationTypes: [{ label: 'Primary' }] },
    ],
    contacts: {
      3001: { email: 'ap@acme.com' },
      3002: { email: 'other@acme.com' },
    },
    lineItemAssociations: ['4001', '4002'],
    lineItems: {
      4001: { name: 'Platform licence', quantity: '2', price: '1000.00' },
      4002: { name: 'Onboarding', quantity: '1', price: '500.50', description: 'One-time setup' },
    },
    ...overrides,
  };
}

function closedWonEvent(inputFields = {}) {
  return {
    object: { objectId: 1001, objectType: 'DEAL' },
    inputFields: {
      dealname: 'Acme — Platform 2026',
      amount: '2500.50',
      closedate: '2026-09-18T10:04:00Z',
      deal_currency_code: 'EUR',
      associated_company_id: '2001',
      hs_object_id: '1001',
      ...inputFields,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('toMinorUnits converts major-unit money to integer minor units', () => {
  assert.equal(toMinorUnits('1250.50'), 125050);
  assert.equal(toMinorUnits(0.1 + 0.2), 30);
  assert.equal(toMinorUnits('1,000'), 100000);
  assert.equal(toMinorUnits(''), null);
  assert.equal(toMinorUnits('not money'), null);
});

test('toIsoDate normalises HubSpot timestamps and epoch millis', () => {
  assert.equal(toIsoDate('2026-09-18T10:04:00Z'), '2026-09-18');
  assert.equal(toIsoDate('2026-09-18'), '2026-09-18');
  assert.equal(toIsoDate('1789740240000'), '2026-09-18');
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate('nonsense'), null);
});

test('addDays applies net-30 terms across a month boundary', () => {
  assert.equal(addDays('2026-09-18', 30), '2026-10-18');
  assert.equal(addDays('2026-12-20', 30), '2027-01-19');
});

test('resolveCurrency keeps supported codes and falls back to USD otherwise', () => {
  assert.deepEqual(resolveCurrency('eur'), { currency: 'EUR', warning: null });
  assert.deepEqual(resolveCurrency(''), { currency: 'USD', warning: null });
  const fallback = resolveCurrency('JPY');
  assert.equal(fallback.currency, 'USD');
  assert.match(fallback.warning, /JPY/);
});

test('truncate caps the invoice memo at the documented 2,000 characters', () => {
  assert.equal(truncate('x'.repeat(2500), 2000).length, 2000);
  assert.equal(truncate('  spaced  ', 2000), 'spaced');
  assert.equal(truncate('', 2000), null);
});

test('orderedContactIds puts the primary association first', () => {
  const ids = orderedContactIds({
    results: [
      { toObjectId: '3002', associationTypes: [{ label: 'Decision maker' }] },
      { toObjectId: '3001', associationTypes: [{ label: 'Primary' }] },
    ],
  });
  assert.deepEqual(ids, ['3001', '3002']);
});

test('mapHubSpotLineItems multiplies quantity by price and keeps descriptions', () => {
  const lines = mapHubSpotLineItems([
    { properties: { name: 'Licence', quantity: '3', price: '99.99' } },
    { properties: { name: 'Support', amount: '250.00' } },
    { properties: { name: 'Broken', quantity: '1' } },
    { properties: { name: 'Setup', quantity: '1', price: '10', description: 'One-off' } },
  ]);
  assert.deepEqual(lines, [
    { name: 'Licence', amount: 29997 },
    { name: 'Support', amount: 25000 },
    { name: 'Setup', amount: 1000, description: 'One-off' },
  ]);
});

test('invoiceIdFromConflict reads the id from the documented and nested shapes', () => {
  assert.equal(invoiceIdFromConflict({ invoice_id: 'a' }), 'a');
  assert.equal(invoiceIdFromConflict({ error: { details: { invoice_id: 'b' } } }), 'b');
  assert.equal(invoiceIdFromConflict({ error: { code: 'ERR' } }), null);
});

test('rejectsLineItemsFormat only matches 400s that name line_items', () => {
  assert.equal(rejectsLineItemsFormat(400, { error: { message: 'line_items must be a string' } }), true);
  assert.equal(rejectsLineItemsFormat(400, { error: { message: 'customer_id invalid' } }), false);
  assert.equal(rejectsLineItemsFormat(422, 'line_items'), false);
});

test('readInputs falls back to the enrolled object id when hs_object_id is absent', () => {
  const inputs = readInputs({ object: { objectId: 55 }, inputFields: { dealname: 'X' } });
  assert.equal(inputs.dealId, '55');
  assert.equal(inputs.dealName, 'X');
});

// ---------------------------------------------------------------------------
// End-to-end action behaviour
// ---------------------------------------------------------------------------

test('creates an invoice from the deal line items and writes the id back', async () => {
  const stub = installFetchStub(happyWorld());
  try {
    const { outputFields } = await action.main(closedWonEvent());

    const [invoiceRequest] = stub.invoiceRequests();
    assert.equal(invoiceRequest.headers['X-SALESBRICKS-KEY'], 'sb-test-key');
    assert.equal(invoiceRequest.headers['Idempotency-Key'], '1001');
    assert.deepEqual(invoiceRequest.body, {
      customer_id: 'cus-uuid-7',
      issued_at: '2026-09-18',
      due_at: '2026-10-18',
      currency: 'EUR',
      send_invoice: false,
      accounts_payable_emails: ['ap@acme.com'],
      metadata: { hubspot_deal_id: '1001' },
      invoice_memo: 'Acme — Platform 2026',
      line_items: [
        { name: 'Platform licence', amount: 200000 },
        { name: 'Onboarding', amount: 50050, description: 'One-time setup' },
      ],
    });

    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: 'CREATED', salesbricks_invoice_id: 'inv-uuid-1' },
    ]);
    assert.equal(outputFields.salesbricksInvoiceId, 'inv-uuid-1');
    assert.equal(outputFields.salesbricksInvoiceStatus, STATUS.CREATED);
    assert.equal(outputFields.currencyWarning, null);
  } finally {
    stub.restore();
  }
});

test('falls back to a single line item built from the deal amount', async () => {
  const stub = installFetchStub(happyWorld({ lineItemAssociations: [], lineItems: {} }));
  try {
    await action.main(closedWonEvent());
    const [invoiceRequest] = stub.invoiceRequests();
    assert.deepEqual(invoiceRequest.body.line_items, [
      { name: 'Acme — Platform 2026', amount: 250050 },
    ]);
  } finally {
    stub.restore();
  }
});

test('unsupported deal currency is invoiced in USD and reported as a warning', async () => {
  const stub = installFetchStub(happyWorld());
  try {
    const { outputFields } = await action.main(
      closedWonEvent({ deal_currency_code: 'JPY' }),
    );
    assert.equal(stub.invoiceRequests()[0].body.currency, 'USD');
    assert.match(outputFields.currencyWarning, /JPY/);
    assert.equal(outputFields.salesbricksInvoiceStatus, STATUS.CREATED);
  } finally {
    stub.restore();
  }
});

test('missing salesbricks_customer_id skips the invoice and flags the deal', async () => {
  const stub = installFetchStub(
    happyWorld({ companies: { 2001: { salesbricks_customer_id: '  ', name: 'Acme' } } }),
  );
  try {
    await assert.rejects(action.main(closedWonEvent()), /salesbricks_customer_id/);
    assert.equal(stub.invoiceRequests().length, 0);
    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: STATUS.MISSING_CUSTOMER_ID },
    ]);
  } finally {
    stub.restore();
  }
});

test('a deal with no company association never falls back to a name search', async () => {
  const stub = installFetchStub(happyWorld({ companyAssociations: [], companies: {} }));
  try {
    await assert.rejects(
      action.main(closedWonEvent({ associated_company_id: '' })),
      /no associated company/i,
    );
    assert.equal(stub.invoiceRequests().length, 0);
    // No customer search of any kind was attempted against Salesbricks.
    assert.equal(
      stub.requests.filter((request) => request.url.includes('api.salesbricks.com')).length,
      0,
    );
    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: STATUS.MISSING_CUSTOMER_ID },
    ]);
  } finally {
    stub.restore();
  }
});

test('missing contact email skips the invoice and flags the deal', async () => {
  const stub = installFetchStub(
    happyWorld({
      contactAssociations: [{ id: '3001', associationTypes: [{ label: 'Primary' }] }],
      contacts: { 3001: { email: '' } },
    }),
  );
  try {
    await assert.rejects(action.main(closedWonEvent()), /no email address/);
    assert.equal(stub.invoiceRequests().length, 0);
    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: STATUS.MISSING_CONTACT_EMAIL },
    ]);
  } finally {
    stub.restore();
  }
});

test('a deal with no associated contact skips the invoice', async () => {
  const stub = installFetchStub(happyWorld({ contactAssociations: [], contacts: {} }));
  try {
    await assert.rejects(action.main(closedWonEvent()), /no associated contact/);
    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: STATUS.MISSING_CONTACT_EMAIL },
    ]);
  } finally {
    stub.restore();
  }
});

test('a 409 conflict is treated as success and the existing id is written back', async () => {
  const stub = installFetchStub(
    happyWorld({
      invoiceResponse: {
        status: 409,
        body: { error: { code: 'ERR_CONFLICT', details: { invoice_id: 'inv-existing' } } },
      },
    }),
  );
  try {
    const { outputFields } = await action.main(closedWonEvent());
    assert.equal(outputFields.salesbricksInvoiceId, 'inv-existing');
    assert.equal(outputFields.salesbricksInvoiceStatus, STATUS.CREATED);
    assert.deepEqual(stub.dealPatches(), [
      { salesbricks_invoice_status: 'CREATED', salesbricks_invoice_id: 'inv-existing' },
    ]);
  } finally {
    stub.restore();
  }
});

test('a 4xx from Salesbricks records API_ERROR and fails the action', async () => {
  const stub = installFetchStub(
    happyWorld({
      invoiceResponse: { status: 400, body: { error: { message: 'customer_id invalid' } } },
    }),
  );
  try {
    await assert.rejects(action.main(closedWonEvent()), /HTTP 400/);
    assert.deepEqual(stub.dealPatches(), [{ salesbricks_invoice_status: STATUS.API_ERROR }]);
  } finally {
    stub.restore();
  }
});

test('a 5xx fails the action for HubSpot to retry without marking API_ERROR', async () => {
  const stub = installFetchStub(
    happyWorld({ invoiceResponse: { status: 503, body: { error: { message: 'unavailable' } } } }),
  );
  try {
    await assert.rejects(action.main(closedWonEvent()), /HTTP 503/);
    assert.deepEqual(stub.dealPatches(), []);
  } finally {
    stub.restore();
  }
});

test('a 400 that names line_items is retried once with a JSON-encoded string', async () => {
  const stub = installFetchStub(
    happyWorld({
      invoiceResponse: [
        { status: 400, body: { error: { message: 'line_items: expected a string' } } },
        { status: 200, body: { invoice_id: 'inv-uuid-2', invoice_number: 'INV-2' } },
      ],
    }),
  );
  try {
    const { outputFields } = await action.main(closedWonEvent());
    const attempts = stub.invoiceRequests();
    assert.equal(attempts.length, 2);
    assert.ok(Array.isArray(attempts[0].body.line_items));
    assert.equal(typeof attempts[1].body.line_items, 'string');
    assert.deepEqual(JSON.parse(attempts[1].body.line_items), attempts[0].body.line_items);
    assert.equal(outputFields.salesbricksInvoiceId, 'inv-uuid-2');
  } finally {
    stub.restore();
  }
});

test('a deal that already carries an invoice id is never invoiced twice', async () => {
  const stub = installFetchStub(
    happyWorld({
      deal: {
        id: '1001',
        properties: { salesbricks_invoice_id: 'inv-earlier', salesbricks_invoice_status: 'CREATED' },
      },
    }),
  );
  try {
    const { outputFields } = await action.main(closedWonEvent());
    assert.equal(outputFields.skipped, 'already_invoiced');
    assert.equal(outputFields.salesbricksInvoiceId, 'inv-earlier');
    assert.equal(stub.invoiceRequests().length, 0);
    assert.deepEqual(stub.dealPatches(), []);
  } finally {
    stub.restore();
  }
});

test('a network failure is surfaced as retryable without flagging the deal', async () => {
  const stub = installFetchStub(
    happyWorld({ invoiceResponse: { networkError: 'socket hang up' } }),
  );
  try {
    await assert.rejects(action.main(closedWonEvent()), /HTTP 0/);
    assert.deepEqual(stub.dealPatches(), []);
  } finally {
    stub.restore();
  }
});

test('the callback style of the workflows runtime receives the same outputs', async () => {
  const stub = installFetchStub(happyWorld());
  try {
    let callbackPayload = null;
    const returned = await action.main(closedWonEvent(), (payload) => {
      callbackPayload = payload;
    });
    assert.deepEqual(callbackPayload, returned);
    assert.equal(callbackPayload.outputFields.salesbricksInvoiceId, 'inv-uuid-1');
  } finally {
    stub.restore();
  }
});
