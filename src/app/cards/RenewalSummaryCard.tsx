import { hubspot } from '@hubspot/ui-extensions';

import { RenewalSummary } from './RenewalSummary.tsx';

hubspot.extend<'crm.record.sidebar'>(() => <RenewalSummary />);
