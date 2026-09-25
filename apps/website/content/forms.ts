// The request-a-demo form, as data: used by the form UI and by the API route that validates it.

export type Field = {
  name: string;
  label: string;
  type: 'text' | 'email' | 'url' | 'textarea' | 'choice' | 'multi';
  required: boolean;
  max: number;
  placeholder?: string;
  options?: readonly string[];
  /** For "choice": a one-line hint under each option, which renders the options as radio cards. */
  hints?: Readonly<Record<string, string>>;
  autoComplete?: string;
};

export type Step = { title: string; fields: Field[] };

export type FormDef = {
  kind: 'demo';
  endpoint: string;
  table: string;
  title: string;
  submitLabel: string;
  successTitle: string;
  successBody: string;
  steps: Step[];
};

export const demoForm: FormDef = {
  kind: 'demo',
  endpoint: '/api/demo-request',
  table: 'site_demo_requests',
  title: 'Request a demo',
  submitLabel: 'Request a demo',
  successTitle: 'Request received.',
  successBody: 'We’ve sent a confirmation to your inbox. Someone from Winsen Labs will reply to set up a walkthrough.',
  // Three columns of similar height on desktop (a landscape form), three steps on mobile.
  steps: [
    {
      title: 'About you',
      fields: [
        { name: 'name', label: 'Full name', type: 'text', required: true, max: 120, autoComplete: 'name' },
        { name: 'email', label: 'Work email', type: 'email', required: true, max: 200, autoComplete: 'email' },
        { name: 'role', label: 'Role or title', type: 'text', required: true, max: 120, placeholder: 'e.g. Head of Customer Success', autoComplete: 'organization-title' },
        { name: 'company', label: 'Company', type: 'text', required: true, max: 160, autoComplete: 'organization' },
        { name: 'website', label: 'Company website', type: 'url', required: false, max: 200, placeholder: 'https://', autoComplete: 'url' },
      ],
    },
    {
      title: 'Your company',
      fields: [
        {
          name: 'industry',
          label: 'Industry',
          type: 'choice',
          required: true,
          max: 40,
          options: ['Banking', 'Lending', 'Insurance', 'Fintech', 'SaaS', 'E-commerce', 'Telecom', 'Other'],
        },
        { name: 'regions', label: 'Countries or regions', type: 'text', required: false, max: 200, placeholder: 'e.g. India, UAE, United Kingdom' },
        { name: 'channels', label: 'Channels you serve customers on', type: 'multi', required: true, max: 200, options: ['WhatsApp', 'Web chat', 'Email', 'Voice', 'Slack/Teams', 'SMS', 'In-app'] },
        { name: 'tools', label: 'Current tools', type: 'text', required: false, max: 300, placeholder: 'e.g. Zendesk, Intercom, Salesforce, HubSpot' },
      ],
    },
    {
      title: 'Your customer success',
      fields: [
        { name: 'team_size', label: 'Customer success team size', type: 'choice', required: true, max: 20, options: ['1–10', '11–50', '51–200', '201–1000', '1000+'] },
        { name: 'customers', label: 'Customers or accounts served', type: 'choice', required: true, max: 20, options: ['Under 1k', '1k–10k', '10k–100k', '100k–1M', '1M+'] },
        { name: 'conversations', label: 'Customer conversations a month', type: 'choice', required: true, max: 20, options: ['Under 5k', '5k–50k', '50k–500k', '500k+'] },
        {
          name: 'goals',
          label: 'What would you like to achieve?',
          type: 'textarea',
          required: true,
          max: 4000,
          placeholder: 'e.g. An AI agent on WhatsApp for card queries, with our team taking over disputes and every change approved.',
        },
      ],
    },
  ],
};

export const allFields = (def: FormDef) => def.steps.flatMap((s) => s.fields);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns the field errors for a set of values; an empty object means valid. Runs in the browser and on the server. */
export function validate(fields: Field[], values: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === 'multi') {
      const raw = values[f.name];
      const picked = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (!picked.length) {
        if (f.required) errors[f.name] = 'Choose at least one';
      } else if (picked.some((x) => !f.options?.includes(x))) errors[f.name] = 'Choose from the list';
      continue;
    }
    const raw = values[f.name];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) {
      if (f.required) errors[f.name] = f.type === 'choice' ? 'Choose one' : 'Required';
      continue;
    }
    if (v.length > f.max) errors[f.name] = `Keep it under ${f.max} characters`;
    else if (f.type === 'email' && !EMAIL.test(v)) errors[f.name] = 'Enter a valid email';
    else if (f.type === 'url' && !/^https?:\/\/\S+\.\S+$/.test(v)) errors[f.name] = 'Enter a full link, starting https://';
    else if (f.options && !f.options.includes(v)) errors[f.name] = 'Choose an option';
  }
  return errors;
}
