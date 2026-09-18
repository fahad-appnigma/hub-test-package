'use strict';

/**
 * A tiny stand-in for the HubSpot + Salesbricks HTTP surface the action talks
 * to. Tests declare the CRM records they want to exist; the stub answers the
 * exact endpoints the action calls and records every request it received.
 */

const DEFAULT_WORLD = {
  deal: { id: '1001', properties: {} },
  companyAssociations: [],
  companies: {},
  contactAssociations: [],
  contacts: {},
  lineItemAssociations: [],
  lineItems: {},
  invoiceResponse: { status: 200, body: { invoice_id: 'inv-uuid-1', invoice_number: 'INV-1' } },
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined || body === null ? '' : JSON.stringify(body)),
  };
}

function associationRows(ids) {
  return ids.map((entry) =>
    typeof entry === 'string'
      ? { toObjectId: entry, associationTypes: [] }
      : { toObjectId: entry.id, associationTypes: entry.associationTypes || [] },
  );
}

function batchResults(ids, store) {
  return ids
    .map((id) => (typeof id === 'string' ? id : id.id))
    .filter((id) => store[id])
    .map((id) => ({ id, properties: store[id] }));
}

/**
 * Installs the stub on `globalThis.fetch` and returns a handle with the
 * captured requests plus a `restore()`.
 */
function installFetchStub(overrides = {}) {
  const world = { ...DEFAULT_WORLD, ...overrides };
  const requests = [];
  const original = globalThis.fetch;
  let invoiceCallCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body, headers: options.headers || {} });

    // ---- Salesbricks -----------------------------------------------------
    if (url.startsWith('https://api.salesbricks.com/api/v2/invoices')) {
      invoiceCallCount += 1;
      const responses = Array.isArray(world.invoiceResponse)
        ? world.invoiceResponse
        : [world.invoiceResponse];
      const response = responses[Math.min(invoiceCallCount, responses.length) - 1];
      if (response.networkError) throw new Error(response.networkError);
      return jsonResponse(response.status, response.body);
    }

    // ---- HubSpot ---------------------------------------------------------
    const path = url.replace('https://api.hubapi.com', '');

    if (method === 'GET' && path.startsWith('/crm/v3/objects/deals/')) {
      if (!world.deal) return jsonResponse(404, { message: 'not found' });
      return jsonResponse(200, world.deal);
    }
    if (method === 'PATCH' && path.startsWith('/crm/v3/objects/deals/')) {
      return jsonResponse(200, { id: world.deal ? world.deal.id : '1001', properties: body.properties });
    }
    if (method === 'GET' && path.startsWith('/crm/v3/objects/companies/')) {
      const companyId = decodeURIComponent(path.split('/')[5].split('?')[0]);
      const company = world.companies[companyId];
      if (!company) return jsonResponse(404, { message: 'not found' });
      return jsonResponse(200, { id: companyId, properties: company });
    }
    if (method === 'GET' && /\/associations\/companies/.test(path)) {
      if (world.companyAssociationsStatus) {
        return jsonResponse(world.companyAssociationsStatus, { message: 'boom' });
      }
      return jsonResponse(200, { results: associationRows(world.companyAssociations) });
    }
    if (method === 'GET' && /\/associations\/contacts/.test(path)) {
      return jsonResponse(200, { results: associationRows(world.contactAssociations) });
    }
    if (method === 'GET' && /\/associations\/line_items/.test(path)) {
      return jsonResponse(200, { results: associationRows(world.lineItemAssociations) });
    }
    if (method === 'POST' && path === '/crm/v3/objects/contacts/batch/read') {
      return jsonResponse(200, { results: batchResults(world.contactAssociations, world.contacts) });
    }
    if (method === 'POST' && path === '/crm/v3/objects/line_items/batch/read') {
      return jsonResponse(200, { results: batchResults(world.lineItemAssociations, world.lineItems) });
    }

    throw new Error(`Unexpected request in test: ${method} ${url}`);
  };

  return {
    requests,
    world,
    restore() {
      globalThis.fetch = original;
    },
    /** Requests sent to Salesbricks. */
    invoiceRequests() {
      return requests.filter((request) => request.url.includes('api.salesbricks.com'));
    },
    /** Deal property write-backs, in order. */
    dealPatches() {
      return requests
        .filter((request) => request.method === 'PATCH' && request.url.includes('/objects/deals/'))
        .map((request) => request.body.properties);
    },
  };
}

module.exports = { installFetchStub };
