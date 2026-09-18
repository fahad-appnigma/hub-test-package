#!/usr/bin/env node
'use strict';

/**
 * Creates the custom properties the Closed Won ➝ Salesbricks invoice action
 * reads and writes. Standard-object properties cannot be declared as project
 * components, so they are provisioned through the Properties API instead.
 *
 * The script is idempotent: a property that already exists is left untouched.
 *
 *   HUBSPOT_ACCESS_TOKEN=pat-... node scripts/create-custom-properties.js
 *   HUBSPOT_ACCESS_TOKEN=pat-... node scripts/create-custom-properties.js --dry-run
 *
 * The token needs `crm.schemas.companies.write` and `crm.schemas.deals.write`.
 */

const BASE_URL = 'https://api.hubapi.com';
const GROUP_NAME = 'salesbricks';
const GROUP_LABEL = 'Salesbricks';

const PROPERTIES = [
  {
    objectType: 'companies',
    name: 'salesbricks_customer_id',
    label: 'Salesbricks customer ID',
    description:
      'UUID of the matching Salesbricks customer. Sole lookup key used when invoicing a Closed Won deal — there is no name-based fallback.',
    type: 'string',
    fieldType: 'text',
  },
  {
    objectType: 'deals',
    name: 'salesbricks_invoice_id',
    label: 'Salesbricks invoice ID',
    description: 'UUID of the Salesbricks invoice created for this deal.',
    type: 'string',
    fieldType: 'text',
  },
  {
    objectType: 'deals',
    name: 'salesbricks_invoice_status',
    label: 'Salesbricks invoice status',
    description:
      'Outcome of the last invoice attempt: CREATED, MISSING_CUSTOMER_ID, MISSING_CONTACT_EMAIL or API_ERROR.',
    type: 'string',
    fieldType: 'text',
  },
];

const token = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const dryRun = process.argv.includes('--dry-run');

async function api(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = text;
    }
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

async function ensureGroup(objectType) {
  const existing = await api(`/crm/v3/properties/${objectType}/groups/${GROUP_NAME}`);
  if (existing.ok) return 'exists';
  if (dryRun) return 'would create';
  const created = await api(`/crm/v3/properties/${objectType}/groups`, {
    method: 'POST',
    body: { name: GROUP_NAME, label: GROUP_LABEL },
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(
      `Failed to create the ${objectType} property group: ${JSON.stringify(created.body)}`,
    );
  }
  return created.status === 409 ? 'exists' : 'created';
}

async function ensureProperty(definition) {
  const { objectType, name } = definition;
  const existing = await api(`/crm/v3/properties/${objectType}/${name}`);
  if (existing.ok) return 'exists';
  if (dryRun) return 'would create';

  const created = await api(`/crm/v3/properties/${objectType}`, {
    method: 'POST',
    body: {
      name,
      label: definition.label,
      description: definition.description,
      type: definition.type,
      fieldType: definition.fieldType,
      groupName: GROUP_NAME,
      hasUniqueValue: false,
      hidden: false,
      formField: false,
    },
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`Failed to create ${objectType}.${name}: ${JSON.stringify(created.body)}`);
  }
  return created.status === 409 ? 'exists' : 'created';
}

async function main() {
  if (!token) {
    console.error('HUBSPOT_ACCESS_TOKEN is not set.');
    process.exit(2);
  }

  for (const objectType of [...new Set(PROPERTIES.map((property) => property.objectType))]) {
    const outcome = await ensureGroup(objectType);
    console.log(`group  ${objectType}.${GROUP_NAME}: ${outcome}`);
  }

  for (const definition of PROPERTIES) {
    const outcome = await ensureProperty(definition);
    console.log(`property ${definition.objectType}.${definition.name}: ${outcome}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
