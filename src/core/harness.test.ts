import { describe, it, expect } from 'vitest';
import { buildObservationScript, buildVerificationScript, safeJsonForInjectedJs, validateInjectedScript } from './harness';

describe('buildVerificationScript', () => {
  it('serializes the field registry into the injected verifier script without template placeholders', () => {
    const sampleRegistry = [
      {
        field_id: 'test_field_1',
        selector: '#some-id',
        selector_candidates: ['#some-id']
      }
    ];

    const script = buildVerificationScript(sampleRegistry as any);

    expect(script).not.toContain('${');
    expect(script).not.toContain('arguments[0]');
    const assignment = script.match(/script = ("(?:\\.|[^"])*")/);
    expect(assignment).not.toBeNull();
    const injected = JSON.parse(assignment![1]) as string;
    expect(injected).toContain(`const registry = ${safeJsonForInjectedJs(sampleRegistry)}`);
    validateInjectedScript(injected, 'unit-field-verifier');
  });

  it('fails preflight when an injected script still contains an uninterpolated placeholder', () => {
    expect(() => validateInjectedScript('(() => { const x = ${bad}; })()', 'unit-placeholder')).toThrow(
      /uninterpolated template placeholder/
    );
  });

  it('does not classify low-opacity option cards as disabled from opacity alone', () => {
    const script = buildObservationScript('https://example.test', false);

    expect(script).not.toContain('parseFloat(style.opacity) < 0.4');
  });
});
