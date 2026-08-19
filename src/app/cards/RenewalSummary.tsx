import {
  DescriptionList,
  DescriptionListItem,
  LoadingSpinner,
  Tag,
  Text,
} from '@hubspot/ui-extensions';
import { useCrmProperties } from '@hubspot/ui-extensions/crm';

/** Internal names of the pre-existing company properties this card reads. */
export const RENEWAL_DATE_PROPERTY = 'renewal_date';
export const RENEWAL_RISK_PROPERTY = 'renewal_risk';

/** Placeholder shown when a property has no value on the company record. */
export const NOT_SET = 'Not set';

export const RENEWAL_PROPERTIES = [
  RENEWAL_DATE_PROPERTY,
  RENEWAL_RISK_PROPERTY,
];

type TagVariant = 'success' | 'warning' | 'error' | 'default';

/**
 * Maps a renewal risk value onto a design-system colour token:
 * Low -> green, Medium -> amber, High -> red. Matching is case-insensitive so
 * that it works against either the dropdown's internal value or its label.
 * Anything unrecognised falls back to the neutral tag rather than guessing.
 */
export const riskVariant = (risk: string): TagVariant => {
  switch (risk.trim().toLowerCase()) {
    case 'low':
      return 'success';
    case 'medium':
      return 'warning';
    case 'high':
      return 'error';
    default:
      return 'default';
  }
};

/** Treats null, undefined and blank strings alike: there is no value to show. */
export const isBlank = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === '';

export const RenewalSummary = () => {
  const { properties, isLoading, error } = useCrmProperties(
    RENEWAL_PROPERTIES,
    {
      // Let HubSpot format the values server-side so the renewal date renders in
      // the portal's standard date format and the risk shows its dropdown label.
      propertiesToFormat: RENEWAL_PROPERTIES,
    },
  );

  if (isLoading) {
    return <LoadingSpinner label="Loading renewal details" />;
  }

  const renewalDate = properties[RENEWAL_DATE_PROPERTY];
  const renewalRisk = properties[RENEWAL_RISK_PROPERTY];

  return (
    <>
      <DescriptionList direction="row">
        <DescriptionListItem label="Renewal date">
          <Text>{isBlank(renewalDate) ? NOT_SET : renewalDate}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Renewal risk">
          {isBlank(renewalRisk) ? (
            <Text>{NOT_SET}</Text>
          ) : (
            <Tag variant={riskVariant(renewalRisk as string)}>
              {renewalRisk}
            </Tag>
          )}
        </DescriptionListItem>
      </DescriptionList>
      {error ? (
        <Text variant="microcopy">
          Renewal details could not be loaded. Refresh the record to try again.
        </Text>
      ) : null}
    </>
  );
};
