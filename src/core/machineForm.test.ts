import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  EMPTY_DRAFT,
  FIELD,
  NONE_GPU,
  asInt,
  draftFromSpec,
  ensureNoneOption,
  isChanged,
  maxCountFor,
  validate,
  type FormDraft,
  type GpuTypeOption,
} from './machineForm';

const OPTIONS: GpuTypeOption[] = [
  { gpuTypeId: NONE_GPU, label: 'No GPU', maxCount: 0 },
  { gpuTypeId: 'a100-40', label: 'NVIDIA A100 40GB', maxCount: 8 },
  { gpuTypeId: 'h100-80', label: 'NVIDIA H100 80GB', maxCount: 4 },
];

function draft(overrides: Partial<FormDraft> = {}): FormDraft {
  return {
    gpuTypeId: 'a100-40',
    gpuCount: '2',
    cpuCores: '32',
    ramGb: '256',
    ssdGb: '1024',
    ...overrides,
  };
}

describe('asInt', () => {
  it('accepts a plain whole number, with surrounding space', () => {
    expect(asInt('42')).toBe(42);
    expect(asInt('  42  ')).toBe(42);
    expect(asInt('0')).toBe(0);
  });

  it.each(['', '   ', '1.5', '1e3', '0x10', '-1', '12abc', 'abc', '+7', '1,000', '½'])(
    'rejects %o, which parseInt would misread',
    (input) => {
      expect(asInt(input)).toBeUndefined();
    },
  );

  it('rejects a number too large to represent exactly', () => {
    expect(asInt('9007199254740993')).toBeUndefined();
  });
});

describe('maxCountFor', () => {
  it('uses the per-type maximum, not one global number', () => {
    expect(maxCountFor('a100-40', OPTIONS)).toBe(8);
    expect(maxCountFor('h100-80', OPTIONS)).toBe(4);
  });

  it('is zero for none and for an unknown type', () => {
    expect(maxCountFor(NONE_GPU, OPTIONS)).toBe(0);
    expect(maxCountFor('retired', OPTIONS)).toBe(0);
  });

  it('falls back to the global limit when the server omits maxCount', () => {
    const options = [{ gpuTypeId: 'mystery', label: 'Mystery', maxCount: 0 }];
    expect(maxCountFor('mystery', options)).toBe(DEFAULT_LIMITS.gpuCountMax);
  });

  it('never exceeds the global limit, even if a type claims more', () => {
    const options = [{ gpuTypeId: 'huge', label: 'Huge', maxCount: 64 }];
    expect(maxCountFor('huge', options)).toBe(DEFAULT_LIMITS.gpuCountMax);
  });
});

describe('validate', () => {
  it('accepts a well-formed draft', () => {
    const result = validate(draft(), OPTIONS);
    expect(result.errors).toEqual({});
    expect(result.spec).toEqual({
      gpuTypeId: 'a100-40',
      gpuCount: 2,
      cpuCores: 32,
      ramGb: 256,
      ssdGb: 1024,
    });
  });

  it('omits gpuCount entirely for none, rather than sending zero', () => {
    const result = validate(draft({ gpuTypeId: NONE_GPU, gpuCount: '4' }), OPTIONS);
    expect(result.errors).toEqual({});
    expect(result.spec).not.toHaveProperty('gpuCount');
  });

  it('requires a gpu count for any type other than none', () => {
    const result = validate(draft({ gpuCount: '' }), OPTIONS);
    expect(result.errors[FIELD.gpuCount]).toBeDefined();
    expect(result.spec).toBeUndefined();
  });

  it('enforces the per-type maximum', () => {
    // 8 is fine on an A100 and too many on an H100.
    expect(validate(draft({ gpuCount: '8' }), OPTIONS).errors[FIELD.gpuCount]).toBeUndefined();
    const h100 = validate(draft({ gpuTypeId: 'h100-80', gpuCount: '8' }), OPTIONS);
    expect(h100.errors[FIELD.gpuCount]).toContain('1 and 4');
  });

  it('reports a retired GPU type without substituting another', () => {
    const result = validate(draft({ gpuTypeId: 'retired' }), OPTIONS);
    expect(result.errors[FIELD.gpuType]).toContain('no longer available');
  });

  it.each([
    ['cpuCores', FIELD.cpuCores, '257', '1 and 256'],
    ['ramGb', FIELD.ramGb, '2049', '1 GB and 2048 GB'],
    ['ssdGb', FIELD.ssdGb, '0', '1 GB and 2048 GB'],
  ] as const)('rejects %s out of range', (field, key, value, message) => {
    const result = validate(draft({ [field]: value }), OPTIONS);
    expect(result.errors[key]).toContain(message);
  });

  it.each(['1e3', '12abc', '1.5'])('rejects %o in a numeric field', (value) => {
    const result = validate(draft({ ramGb: value }), OPTIONS);
    expect(result.errors[FIELD.ramGb]).toBe('Enter a whole number.');
  });

  it('reports every bad field at once, not just the first', () => {
    const result = validate(draft({ cpuCores: 'x', ramGb: '', ssdGb: '99999' }), OPTIONS);
    expect(Object.keys(result.errors).sort()).toEqual(
      [FIELD.cpuCores, FIELD.ramGb, FIELD.ssdGb].sort(),
    );
  });

  it('keys errors by proto path, so a server violation lands on the same field', () => {
    const result = validate(draft({ ramGb: '99999' }), OPTIONS);
    expect(Object.keys(result.errors)).toEqual(['spec.ram_gb']);
  });

  it('respects server-supplied limits over the defaults', () => {
    const tight = { ...DEFAULT_LIMITS, ramGbMax: 512 };
    expect(validate(draft({ ramGb: '1024' }), OPTIONS, tight).errors[FIELD.ramGb]).toContain('512');
  });
});

describe('draftFromSpec', () => {
  it('renders a spec as raw strings', () => {
    expect(
      draftFromSpec({ gpuTypeId: 'a100-40', gpuCount: 2, cpuCores: 32, ramGb: 256, ssdGb: 1024 }),
    ).toEqual({ gpuTypeId: 'a100-40', gpuCount: '2', cpuCores: '32', ramGb: '256', ssdGb: '1024' });
  });

  it('gives an empty draft for a machine with no current configuration', () => {
    expect(draftFromSpec(undefined)).toEqual(EMPTY_DRAFT);
  });
});

describe('isChanged', () => {
  const current = { gpuTypeId: 'a100-40', gpuCount: 2, cpuCores: 32, ramGb: 256, ssdGb: 1024 };

  it('is false for a draft matching the current configuration', () => {
    expect(isChanged(draftFromSpec(current), current)).toBe(false);
  });

  it.each([
    ['cpuCores', '64'],
    ['ramGb', '512'],
    ['ssdGb', '2048'],
    ['gpuCount', '4'],
    ['gpuTypeId', 'h100-80'],
  ] as const)('is true when %s differs', (field, value) => {
    expect(isChanged({ ...draftFromSpec(current), [field]: value }, current)).toBe(true);
  });

  it('ignores formatting differences that mean the same number', () => {
    expect(isChanged({ ...draftFromSpec(current), cpuCores: ' 32 ' }, current)).toBe(false);
  });

  it('does not count a hidden gpu count, so toggling to none and back is not a change', () => {
    const toNone = { ...draftFromSpec(current), gpuTypeId: NONE_GPU };
    const backAgain = { ...toNone, gpuTypeId: 'a100-40' };
    expect(isChanged(toNone, current)).toBe(true);
    expect(isChanged(backAgain, current)).toBe(false);
  });

  it('treats anything entered as a change when there is no current configuration', () => {
    expect(isChanged(EMPTY_DRAFT, undefined)).toBe(false);
    expect(isChanged({ ...EMPTY_DRAFT, cpuCores: '8' }, undefined)).toBe(true);
  });
});

describe('ensureNoneOption', () => {
  it('leaves a catalogue that already offers none alone', () => {
    const result = ensureNoneOption(OPTIONS);
    expect(result.synthesized).toBe(false);
    expect(result.options).toBe(OPTIONS);
  });

  it('synthesises one when the server omits it, and says so', () => {
    // A form with no way to say "no GPU" is broken, so this is repaired rather
    // than surfaced as an error - but it is not silent.
    const result = ensureNoneOption([OPTIONS[1]!]);
    expect(result.synthesized).toBe(true);
    expect(result.options[0]?.gpuTypeId).toBe(NONE_GPU);
  });
});
