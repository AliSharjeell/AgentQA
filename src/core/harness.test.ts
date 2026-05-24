import { describe, it, expect } from 'vitest';
import { buildVerificationScript } from './harness';

describe('buildVerificationScript', () => {
  it('Injected verifier does not use arguments[0] and successfully reads values from a sample registry', () => {
    const sampleRegistry = [
      {
        field_id: 'test_field_1',
        selector: '#some-id',
        selector_candidates: ['#some-id']
      }
    ];

    const script = buildVerificationScript(sampleRegistry as any);

    // Should contain the serialized json
    expect(script).toContain(JSON.stringify(JSON.stringify(sampleRegistry)));
    
    // Should NOT contain arguments[0]
    expect(script).not.toContain('arguments[0]');
    
    // Should contain the embedded registry assignment
    expect(script).toContain('const registry = " + json.dumps(registry) + ";');
  });
});
