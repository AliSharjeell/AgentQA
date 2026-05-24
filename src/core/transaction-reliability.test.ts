import { describe, expect, it } from 'vitest';
import type { FieldRegistryEntry, QaRunAction } from '../shared/types';
import type { ExecutorActionOutcome } from './executor';
import type { ObservedElement, PageObservation, StructuredAction } from './harness';
import { splitSafe } from './chunker';
import { createTestPlan } from './planner';
import { applyVerifierRuntimeWarning, buildQaRunResult } from './reporter';
import {
  buildCompactFinalState,
  buildObjectiveProgress,
  classifyTransactionAction,
  classifyTransactionLabel,
  findNextUnresolvedSection,
  isEmptyObservation,
  relevantFieldsForVerification,
  repeatedCartViewNoProgress
} from './state';
import { verifyAction, verifyPlanAssertions } from './verification';

const TASK = 'add product to cart';

function element(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    id: overrides.id || 'elem_0',
    type: overrides.type || 'button',
    description: overrides.description || 'Add to Bag',
    tag: overrides.tag || 'button',
    selector: overrides.selector || '#add',
    x: overrides.x ?? 100,
    y: overrides.y ?? 120,
    visible: overrides.visible ?? true,
    disabled: overrides.disabled ?? false,
    text: overrides.text,
    role: overrides.role,
    href: overrides.href,
    checked: overrides.checked,
    selected: overrides.selected,
    value: overrides.value,
    ...overrides
  };
}

function field(index: number, overrides: Partial<FieldRegistryEntry> = {}): FieldRegistryEntry {
  return {
    field_id: overrides.field_id || `field_${index}`,
    temporary_observation_id: overrides.temporary_observation_id || `elem_field_${index}`,
    label: overrides.label || `Field ${index}`,
    selector: overrides.selector || `#field-${index}`,
    selector_candidates: overrides.selector_candidates || [`#field-${index}`],
    tag: overrides.tag || 'input',
    type: overrides.type || 'text',
    name: overrides.name || `field_${index}`,
    html_id: overrides.html_id || `field-${index}`,
    initial_value: overrides.initial_value || '',
    label_source: overrides.label_source || 'id',
    confidence: overrides.confidence ?? 1,
    bbox: overrides.bbox || { x: 0, y: index, width: 100, height: 20 },
    nearby_text: overrides.nearby_text || [],
    ...overrides
  };
}

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  const elements = overrides.elementRegistry || overrides.availableElements || [];
  return {
    taskUrl: 'https://example.test',
    page: {
      url: 'https://example.test/product',
      title: 'Product Pro',
      w: 1365,
      h: 768,
      pw: 1365,
      ph: 2400,
      sy: 900,
      ...(overrides.page || {})
    },
    elementRegistry: elements,
    availableElements: overrides.availableElements || elements,
    interactiveElements: overrides.interactiveElements || elements,
    fieldRegistry: overrides.fieldRegistry ?? [],
    pageText: overrides.pageText ?? 'Product Pro configuration page. Choose your options.',
    consoleErrors: overrides.consoleErrors ?? [],
    networkErrors: overrides.networkErrors ?? [],
    compactFinalState: overrides.compactFinalState,
    actionDetails: overrides.actionDetails
  };
}

function successAction(action: string, label: string, overrides: Partial<QaRunAction> = {}): QaRunAction {
  return {
    action_id: overrides.action_id || 'A001',
    action,
    target: label,
    label,
    selector: overrides.selector,
    input: overrides.input,
    planned_value: overrides.planned_value,
    action_result: 'SUCCESS',
    verification: { expected: 'Action completed', actual: 'Action completed', status: 'PASS' },
    timestamp: '2026-05-24T00:00:00.000Z',
    ...overrides
  };
}

function transactionResult(obs: PageObservation, actions: QaRunAction[]) {
  const plan = createTestPlan({ prompt: TASK, targetUrl: 'https://example.test' });
  const compact = buildCompactFinalState({ task: TASK, intent: 'TRANSACTION_OR_CART', observation: obs, actions });
  const finalObservation = { ...obs, compactFinalState: compact };
  const assertions = verifyPlanAssertions({
    plan,
    observation: finalObservation,
    actions,
    evidence: [],
    llmReport: null
  });
  return buildQaRunResult({
    runId: 'qa-run-transaction-unit',
    plan,
    targetUrl: 'https://example.test',
    startedAt: '2026-05-24T00:00:00.000Z',
    endedAt: '2026-05-24T00:00:01.000Z',
    durationMs: 1000,
    actions,
    assertions,
    observations: [finalObservation],
    llmReport: null,
    evidence: [],
    evidenceWarnings: [],
    artifacts: {
      html_report: 'report.html',
      markdown_report: 'report.md',
      json_result: 'result.json',
      screenshots_dir: 'screenshots/',
      action_trace: 'action-trace.json',
      dom_after: 'dom-after.json'
    }
  });
}

describe('transaction/navigation reliability', () => {
  it('prioritizes wait/re-observe for an empty observation after navigation', () => {
    const empty = observation({
      elementRegistry: [],
      availableElements: [],
      interactiveElements: [],
      fieldRegistry: [],
      pageText: '',
      page: { url: 'https://example.test/configure', title: '' }
    });
    const progress = buildObjectiveProgress({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: empty,
      actions: [],
      history: [{ action: 'click', targetId: 'buy', status: 'success', result: 'Navigated to configure page', url: 'https://example.test/configure' } as any]
    });

    expect(isEmptyObservation(empty)).toBe(true);
    expect(progress.action_priority[0]).toContain('Wait 1s and re-observe');
    expect(progress.warnings[0]).toContain('Observation is empty');
  });

  it('gates final CTA search when visible prerequisite option groups are unresolved', () => {
    const obs = observation({
      elementRegistry: [
        element({ id: 'color_blue', type: 'radio', role: 'radio', description: 'Choose color Blue', selector: '#blue' }),
        element({ id: 'size_large', type: 'radio', role: 'radio', description: 'Select size Large', selector: '#large' })
      ],
      pageText: 'Configure Product Pro. Choose color. Select size.'
    });
    const section = findNextUnresolvedSection({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: obs,
      actions: []
    });
    const progress = buildObjectiveProgress({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: obs,
      actions: [],
      history: []
    });

    expect(section?.candidate_actions.map((action) => action.id)).toContain('color_blue');
    expect(progress.final_cta_search_gated).toBe(true);
    expect(progress.action_priority[0]).toContain('Resolve visible required section');
  });

  it('splits separator-delimited content with an over-limit chunk without throwing', () => {
    const chunks = splitSafe(`${'a'.repeat(80)}\n\n${'b'.repeat(80)}`, 25);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 25)).toBe(true);
  });

  it('limits non-form verification to touched fields instead of every field on the page', () => {
    const registry = Array.from({ length: 200 }, (_, index) => field(index));
    const untouched = relevantFieldsForVerification({
      intent: 'TRANSACTION_OR_CART',
      registry,
      actions: []
    });
    const touched = relevantFieldsForVerification({
      intent: 'TRANSACTION_OR_CART',
      registry,
      actions: [successAction('select', 'Field 42', { field_id: 'field_42', selector: '#field-42', input: 'Blue' })]
    });

    expect(untouched).toHaveLength(0);
    expect(touched.map((entry) => entry.field_id)).toEqual(['field_42']);
  });

  it('treats a product page with an unclicked add action as goal not reached', () => {
    const result = transactionResult(
      observation({
        elementRegistry: [element({ description: 'Add to Bag' })],
        fieldRegistry: [field(1, { label: 'Color', value: 'Blue' })],
        pageText: 'Product Pro Blue configuration. Add to Bag.'
      }),
      [successAction('click', 'Choose Blue')]
    );

    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('GOAL_NOT_REACHED');
    expect(result.assertions.find((assertion) => assertion.id === 'M5_ADD_ACTION_CLICKED')?.status).toBe('BLOCKED');
  });

  it('classifies a shopping bag icon as cart view, not an add action', () => {
    expect(classifyTransactionLabel('Shopping Bag')).toBe('CART_VIEW');
    expect(classifyTransactionLabel('Review Bag')).toBe('CART_VIEW');
    expect(classifyTransactionLabel('Add to Bag')).toBe('ADD_ACTION');
    expect(classifyTransactionAction(successAction('click', 'Shopping Bag'))).toBe('CART_VIEW');
    expect(classifyTransactionAction(successAction('click', 'Shopping Bag'))).not.toBe('ADD_ACTION');
  });

  it('reports a missing add CTA as blocked without a product issue', () => {
    const result = transactionResult(
      observation({
        elementRegistry: [element({ description: 'Shopping Bag', selector: '#bag' })],
        fieldRegistry: [field(1, { label: 'Finish', value: 'Natural' })],
        pageText: 'Product Pro configuration. Finish Natural selected.'
      }),
      [successAction('click', 'Choose Natural')]
    );

    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('CTA_NOT_FOUND');
    expect(result.product_issues).toEqual([]);
    expect(result.issues.every((issue) => issue.type !== 'WEBSITE_BUG')).toBe(true);
  });

  it('documents verifier crashes as warnings for non-form transaction failures', () => {
    const result = transactionResult(
      observation({
        elementRegistry: [element({ description: 'Shopping Bag', selector: '#bag' })],
        fieldRegistry: [field(1, { label: 'Finish', value: 'Natural' })],
        pageText: 'Product Pro configuration. Finish Natural selected.'
      }),
      [successAction('click', 'Choose Natural')]
    );

    applyVerifierRuntimeWarning(result, new Error('Separator is found, but chunk is longer than limit'));

    expect(result.status).toBe('BLOCKED');
    expect(result.root_cause).toBe('CTA_NOT_FOUND');
    expect(result.verifier_issues?.some((issue) => issue.type === 'VERIFIER_RUNTIME_ERROR')).toBe(true);
    expect(result.product_issues).toEqual([]);
  });

  it('does not reject a successful label/card click only because the target metadata says disabled', () => {
    const target = element({ id: 'card_1', description: 'Option card', disabled: true, selector: '#option-card' });
    const obs = observation({ elementRegistry: [{ ...target, disabled: false, selected: true }] });
    const outcome: ExecutorActionOutcome = {
      ok: true,
      status: 'success',
      message: 'Clicked option card',
      observation: obs,
      actionResult: 'Clicked option card',
      executor: 'standard-cdp'
    };
    const action: StructuredAction = { action: 'click', targetId: 'card_1', _target: target };

    const verified = verifyAction({
      actionId: 'A001',
      action,
      target,
      outcome,
      timestamp: '2026-05-24T00:00:00.000Z'
    });

    expect(verified.action_result).toBe('SUCCESS');
    expect(verified.verification?.status).toBe('PASS');
  });

  it('detects repeated cart-view actions as no progress', () => {
    const actions = [
      successAction('click', 'Shopping Bag', { action_id: 'A001' }),
      successAction('click', 'Shopping Bag', { action_id: 'A002' }),
      successAction('click', 'Shopping Bag', { action_id: 'A003' })
    ];

    expect(repeatedCartViewNoProgress(actions)).toBe(true);
  });

  it('records repeated no-progress scrolls so the planner changes strategy', () => {
    const progress = buildObjectiveProgress({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: observation({ elementRegistry: [element({ description: 'Choose option A', type: 'radio', role: 'radio' })] }),
      actions: [],
      history: [
        { action: 'scroll', status: 'blocked', result: 'Blocked scroll loop: already scrolled without observable page progress.', url: 'https://example.test/product' },
        { action: 'scroll', status: 'blocked', result: 'Blocked scroll loop: already scrolled without observable page progress.', url: 'https://example.test/product' },
        { action: 'scroll', status: 'blocked', result: 'Blocked scroll loop: already scrolled without observable page progress.', url: 'https://example.test/product' }
      ] as any
    });

    expect(progress.recent_no_progress_actions).toHaveLength(3);
    expect(progress.action_priority.join(' ')).toContain('Resolve visible required section');
  });

  it('generates milestone-based transaction acceptance criteria', () => {
    const plan = createTestPlan({ prompt: TASK, targetUrl: 'https://example.test' });

    expect(plan.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(['AC-001', 'AC-002', 'AC-003', 'AC-004', 'AC-005']);
    expect(plan.assertions.map((assertion) => assertion.id)).toEqual([
      'M1_TARGET_ITEM_FOUND',
      'M2_CONFIGURATION_STARTED',
      'M3_REQUIRED_OPTIONS_RESOLVED',
      'M4_ADD_ACTION_FOUND',
      'M5_ADD_ACTION_CLICKED',
      'M6_CART_OR_BAG_VERIFIED'
    ]);
    expect(plan.acceptanceCriteria.find((criterion) => criterion.id === 'AC-002')?.assertionIds).toEqual([
      'M2_CONFIGURATION_STARTED',
      'M3_REQUIRED_OPTIONS_RESOLVED'
    ]);
  });

  it('builds a bounded compact final state for large pages', () => {
    const elements = Array.from({ length: 300 }, (_, index) => element({
      id: `elem_${index}`,
      description: `Add to Bag Product Option ${index} ${'x'.repeat(200)}`,
      selector: `#action-${index}`,
      text: 'Large repeated text '.repeat(20),
      x: index,
      y: index * 10
    }));
    const compact = buildCompactFinalState({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: observation({
        elementRegistry: elements,
        pageText: 'Product Pro '.repeat(2000)
      }),
      actions: [],
      limits: { maxPageText: 1000, maxVerifierElements: 10, maxTextPerElement: 40 }
    });

    expect(compact.pageTextExcerpt.length).toBeLessThanOrEqual(1000);
    expect(compact.candidateActions.length).toBeLessThanOrEqual(10);
    expect(compact.candidateActions.every((item) => item.label.length <= 40)).toBe(true);
  });

  it('models a configurable local product flow as options first, add second, cart verification last', () => {
    const firstObservation = observation({
      elementRegistry: [
        element({ id: 'option_a', type: 'radio', role: 'radio', description: 'Choose option A', selector: '#option-a' }),
        element({ id: 'option_b', type: 'radio', role: 'radio', description: 'Select option B', selector: '#option-b' })
      ],
      pageText: 'Configure Product Pro. Choose option A. Select option B.'
    });
    const firstProgress = buildObjectiveProgress({
      task: TASK,
      intent: 'TRANSACTION_OR_CART',
      observation: firstObservation,
      actions: [],
      history: []
    });
    const finalObservation = observation({
      page: { url: 'https://example.test/cart', title: 'Cart' },
      elementRegistry: [element({ id: 'cart', description: 'Cart 1 item Product Pro', selector: '#cart' })],
      fieldRegistry: [
        field(1, { label: 'Option A', value: 'Selected' }),
        field(2, { label: 'Option B', value: 'Selected' })
      ],
      pageText: 'Cart. Product Pro. Quantity 1. Checkout available.'
    });
    const result = transactionResult(finalObservation, [
      successAction('click', 'Choose option A', { action_id: 'A001' }),
      successAction('click', 'Select option B', { action_id: 'A002' }),
      successAction('click', 'Add to Cart', { action_id: 'A003' })
    ]);

    expect(firstProgress.final_cta_search_gated).toBe(true);
    expect(firstProgress.next_unresolved_section?.candidate_actions[0].id).toBe('option_a');
    expect(result.status).toBe('PASS');
    expect(result.assertions.find((assertion) => assertion.id === 'M6_CART_OR_BAG_VERIFIED')?.status).toBe('PASS');
  });
});
