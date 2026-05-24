import type { QaTemplate } from '../shared/types';

export const QA_TEMPLATES: QaTemplate[] = [
  {
    id: 'full-form-fill',
    title: 'Full Form Fill Test',
    category: 'form',
    url: 'https://www.roboform.com/filling-test-all-fields',
    task: 'Fill the form with dummy data and check if all fields are fillable.'
  },
  {
    id: 'login-negative',
    title: 'Login Negative Test',
    category: 'login',
    url: 'https://www.saucedemo.com/',
    task: 'Try logging in with invalid credentials and verify the app shows a proper error message. Use username invalid_user and password wrong_password.'
  },
  {
    id: 'ecommerce-add-to-cart',
    title: 'E-commerce Add-to-Cart Flow',
    category: 'ecommerce',
    url: 'https://ecommerce-playground.lambdatest.io/',
    task: 'Search for iPhone, open product details, add it to cart, and verify cart contains the item.'
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

