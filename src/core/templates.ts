import type { QaTemplate } from '../shared/types';

export const QA_TEMPLATES: QaTemplate[] = [
  {
    id: 'full-form-fill',
    title: 'Form Interaction Test',
    category: 'form',
    task: 'Fill the visible editable fields with safe dummy data and verify the final field values.'
  },
  {
    id: 'auth-negative',
    title: 'Authentication Negative Test',
    category: 'auth',
    task: 'When an authentication form is available, try safe invalid test credentials and verify the final success or error state.'
  },
  {
    id: 'transaction-cart',
    title: 'Cart/Transaction Flow',
    category: 'transaction',
    task: 'Find a requested item, select required visible options, add it to the cart or bag, and verify the final cart state.'
  },
  {
    id: 'responsive-mobile-smoke',
    title: 'Responsive/Mobile Smoke Test',
    category: 'responsive',
    task: 'Open the homepage on desktop and mobile viewport and check if the main navigation and primary CTA are usable.'
  },
  {
    id: 'accessibility-quick-check',
    title: 'Accessibility Quick Check',
    category: 'accessibility',
    task: 'Check whether this page has basic accessibility issues.'
  }
];

export function listQaTemplates(): QaTemplate[] {
  return QA_TEMPLATES.map((template) => ({ ...template }));
}

export function getQaTemplate(templateId: string | undefined): QaTemplate | null {
  if (!templateId) return null;
  return QA_TEMPLATES.find((template) => template.id === templateId) ?? null;
}
