import { DescriptionListItem, LoadingSpinner, Tag, Text } from '@hubspot/ui-extensions';
import { createRenderer } from '@hubspot/ui-extensions/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOT_SET,
  RENEWAL_DATE_PROPERTY,
  RENEWAL_RISK_PROPERTY,
  RenewalSummary,
} from '../src/app/cards/RenewalSummary.tsx';

type Properties = Record<string, string | null>;

let renderer: ReturnType<typeof createRenderer<'crm.record.sidebar'>>;

const mockProperties = (properties: Properties, overrides: Record<string, unknown> = {}) => {
  renderer.mocks.useCrmProperties.willCall(
    () =>
      ({
        properties,
        error: null,
        isLoading: false,
        isRefetching: false,
        refetch: async () => {},
        ...overrides,
      }) as never,
  );
};

/** The text rendered inside the row with the given label, whatever renders it. */
const rowText = (label: string) => {
  const row = renderer.find(DescriptionListItem, { label });
  return (row.maybeFind(Text) ?? row.maybeFind(Tag))?.text ?? null;
};

beforeEach(() => {
  renderer = createRenderer('crm.record.sidebar');
});

describe('property reads', () => {
  it('asks HubSpot for both renewal properties, formatted', () => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: '3/1/2027', [RENEWAL_RISK_PROPERTY]: 'Low' });
    renderer.render(<RenewalSummary />);

    const [propertyNames, options] = renderer.mocks.useCrmProperties.calls[0];
    expect(propertyNames).toEqual([RENEWAL_DATE_PROPERTY, RENEWAL_RISK_PROPERTY]);
    expect(options?.propertiesToFormat).toEqual([
      RENEWAL_DATE_PROPERTY,
      RENEWAL_RISK_PROPERTY,
    ]);
  });

  it('shows a spinner while the values are loading', () => {
    mockProperties({}, { isLoading: true });
    renderer.render(<RenewalSummary />);

    expect(renderer.find(LoadingSpinner).props.label).toEqual('Loading renewal details');
  });
});

describe('renewal date', () => {
  it("renders the value HubSpot formatted, without reformatting it", () => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: '3/1/2027', [RENEWAL_RISK_PROPERTY]: 'Low' });
    renderer.render(<RenewalSummary />);

    expect(rowText('Renewal date')).toEqual('3/1/2027');
  });
});

describe('renewal risk colour coding', () => {
  const cases: Array<[string, string]> = [
    ['Low', 'success'],
    ['Medium', 'warning'],
    ['High', 'error'],
    ['low', 'success'],
    ['medium', 'warning'],
    ['high', 'error'],
  ];

  it.each(cases)('renders %s as a %s tag', (risk, variant) => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: '3/1/2027', [RENEWAL_RISK_PROPERTY]: risk });
    renderer.render(<RenewalSummary />);

    const tag = renderer.find(Tag);
    expect(tag.props.variant).toEqual(variant);
    expect(tag.text).toEqual(risk);
  });

  it('falls back to a neutral tag for an unrecognised value', () => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: null, [RENEWAL_RISK_PROPERTY]: 'Unknown' });
    renderer.render(<RenewalSummary />);

    const tag = renderer.find(Tag);
    expect(tag.props.variant).toEqual('default');
    expect(tag.text).toEqual('Unknown');
  });
});

describe('empty values', () => {
  const empties: Array<[string, string | null]> = [
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
  ];

  it.each(empties)('renders "Not set" when the date is %s', (_label, value) => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: value, [RENEWAL_RISK_PROPERTY]: 'High' });
    renderer.render(<RenewalSummary />);

    expect(rowText('Renewal date')).toEqual(NOT_SET);
  });

  it.each(empties)('renders "Not set" and no tag when the risk is %s', (_label, value) => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: '3/1/2027', [RENEWAL_RISK_PROPERTY]: value });
    renderer.render(<RenewalSummary />);

    expect(rowText('Renewal risk')).toEqual(NOT_SET);
    expect(renderer.maybeFind(Tag)).toBeNull();
  });

  it('renders both rows when the property is absent from the response entirely', () => {
    mockProperties({});
    renderer.render(<RenewalSummary />);

    expect(rowText('Renewal date')).toEqual(NOT_SET);
    expect(rowText('Renewal risk')).toEqual(NOT_SET);
  });
});

describe('fetch failure', () => {
  it('still renders both rows plus an explanation instead of throwing', () => {
    mockProperties({}, { error: new Error('boom') });
    renderer.render(<RenewalSummary />);

    expect(rowText('Renewal date')).toEqual(NOT_SET);
    expect(rowText('Renewal risk')).toEqual(NOT_SET);
    expect(renderer.find(Text, { variant: 'microcopy' }).text).toContain(
      'could not be loaded',
    );
  });
});

describe('read-only', () => {
  it('renders no interactive elements', () => {
    mockProperties({ [RENEWAL_DATE_PROPERTY]: '3/1/2027', [RENEWAL_RISK_PROPERTY]: 'High' });
    const root = renderer.render(<RenewalSummary />);

    expect(root.toString()).not.toMatch(/Button|Input|Form|Select|Toggle/);
    expect(renderer.find(Tag).props.onClick).toBeUndefined();
  });
});
