/**
 * The machine configuration form's rules, declared once.
 *
 * Shared by the webview (which renders and gives immediate feedback) and the
 * extension (which validates again before sending, because a webview is not a
 * trustworthy input source). One declaration is also what keeps a later
 * server-driven schema a contained change rather than a rewrite.
 *
 * No `vscode` import and no protobuf types: this is bundled into the webview
 * too, where neither exists.
 */

export const NONE_GPU = 'none';

/** Field keys are proto paths, so a server field violation maps straight onto an input. */
export const FIELD = {
  gpuType: 'spec.gpu_type_id',
  gpuCount: 'spec.gpu_count',
  cpuCores: 'spec.cpu_cores',
  ramGb: 'spec.ram_gb',
  ssdGb: 'spec.ssd_gb',
} as const;

export type FieldKey = (typeof FIELD)[keyof typeof FIELD];

export interface GpuTypeOption {
  gpuTypeId: string;
  label: string;
  maxCount: number;
}

export interface Limits {
  gpuCountMin: number;
  gpuCountMax: number;
  cpuCoresMin: number;
  cpuCoresMax: number;
  ramGbMin: number;
  ramGbMax: number;
  ssdGbMin: number;
  ssdGbMax: number;
}

/** Applied when the server omits `limits`, per the documented ranges. */
export const DEFAULT_LIMITS: Limits = {
  gpuCountMin: 1,
  gpuCountMax: 8,
  cpuCoresMin: 1,
  cpuCoresMax: 256,
  ramGbMin: 1,
  ramGbMax: 2048,
  ssdGbMin: 1,
  ssdGbMax: 2048,
};

export interface MachineSpec {
  gpuTypeId: string;
  /** Absent when gpuTypeId is `none` — never zero. */
  gpuCount?: number | undefined;
  cpuCores: number;
  ramGb: number;
  ssdGb: number;
}

/**
 * What the user has typed, as raw strings.
 *
 * Strings rather than numbers so a half-typed `12` in the RAM field survives a
 * reload as `12` instead of being dropped for failing validation, and so the
 * value shown back is the value entered.
 */
export interface FormDraft {
  gpuTypeId: string;
  /** Kept even while hidden, so toggling to `none` and back restores it. */
  gpuCount: string;
  cpuCores: string;
  ramGb: string;
  ssdGb: string;
}

export const EMPTY_DRAFT: FormDraft = {
  gpuTypeId: '',
  gpuCount: '',
  cpuCores: '',
  ramGb: '',
  ssdGb: '',
};

/**
 * Strict non-negative integer parsing.
 *
 * `parseInt` is deliberately avoided: it reads `"12abc"` as 12 and `"0x10"` as
 * 16, which is exactly the class of silent misprovisioning this form must not
 * produce.
 */
export function asInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function draftFromSpec(spec: MachineSpec | undefined): FormDraft {
  if (!spec) {
    return { ...EMPTY_DRAFT };
  }
  return {
    gpuTypeId: spec.gpuTypeId,
    gpuCount: spec.gpuCount === undefined ? '' : String(spec.gpuCount),
    cpuCores: String(spec.cpuCores),
    ramGb: String(spec.ramGb),
    ssdGb: String(spec.ssdGb),
  };
}

/**
 * The largest GPU count this type allows.
 *
 * Per-type rather than a single global maximum: node topologies differ per
 * accelerator. The global limit still caps it, so a server sending a larger
 * `maxCount` than it allows overall cannot widen the range.
 */
export function maxCountFor(
  gpuTypeId: string,
  options: GpuTypeOption[],
  limits: Limits = DEFAULT_LIMITS,
): number {
  if (gpuTypeId === NONE_GPU) {
    return 0;
  }
  const option = options.find((candidate) => candidate.gpuTypeId === gpuTypeId);
  if (!option) {
    return 0;
  }
  // A type that omits maxCount falls back to the global limit rather than to
  // zero, which would make the field unusable.
  const perType = option.maxCount > 0 ? option.maxCount : limits.gpuCountMax;
  return Math.min(perType, limits.gpuCountMax);
}

/**
 * Positions a slider can rest on.
 *
 * A linear 1..2048 slider in a ~300px sidebar is about seven values per pixel,
 * so dragging it to an exact number is not possible. Over a wide range the
 * slider therefore steps through a curated scale of round values — quick to
 * reach the shape you want — while the paired text input still accepts any
 * integer for the times you need 300 rather than 256.
 *
 * Small ranges (a GPU count of 1..8) get every value, where a slider is exact
 * anyway.
 */
export function sliderScale(min: number, max: number): number[] {
  if (max <= min) {
    return [min];
  }
  if (max - min <= 32) {
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }

  const values = new Set<number>([min, max]);
  for (let value = 1; value <= max; value *= 2) {
    if (value >= min) {
      values.add(value);
    }
    // Halfway points above 16, so the gaps near the top stay navigable without
    // littering the low end with 1.5 and 3.
    const midpoint = value * 1.5;
    if (value >= 16 && midpoint <= max && midpoint >= min) {
      values.add(midpoint);
    }
  }
  return [...values].sort((left, right) => left - right);
}

/** The scale position closest to a value, for showing where an arbitrary number sits. */
export function nearestScaleIndex(scale: number[], value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, candidate] of scale.entries()) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export type FieldErrors = Partial<Record<FieldKey, string>>;

export interface ValidationResult {
  errors: FieldErrors;
  /** Present only when every field is valid. */
  spec?: MachineSpec | undefined;
}

export function validate(
  draft: FormDraft,
  options: GpuTypeOption[],
  limits: Limits = DEFAULT_LIMITS,
): ValidationResult {
  const errors: FieldErrors = {};

  const known = options.some((option) => option.gpuTypeId === draft.gpuTypeId);
  if (draft.gpuTypeId === '') {
    errors[FIELD.gpuType] = 'Choose a GPU type.';
  } else if (!known) {
    // Reached when the current configuration names a type the catalogue no
    // longer offers. Never silently substituted for another accelerator.
    errors[FIELD.gpuType] = 'This GPU type is no longer available.';
  }

  let gpuCount: number | undefined;
  if (known && draft.gpuTypeId !== NONE_GPU) {
    const max = maxCountFor(draft.gpuTypeId, options, limits);
    const parsed = asInt(draft.gpuCount);
    if (parsed === undefined) {
      errors[FIELD.gpuCount] = 'Choose how many GPUs.';
    } else if (parsed < limits.gpuCountMin || parsed > max) {
      errors[FIELD.gpuCount] = `Must be between ${limits.gpuCountMin} and ${max}.`;
    } else {
      gpuCount = parsed;
    }
  }

  const cpuCores = checkRange(
    draft.cpuCores,
    limits.cpuCoresMin,
    limits.cpuCoresMax,
    '',
    errors,
    FIELD.cpuCores,
  );
  const ramGb = checkRange(draft.ramGb, limits.ramGbMin, limits.ramGbMax, ' GB', errors, FIELD.ramGb);
  const ssdGb = checkRange(draft.ssdGb, limits.ssdGbMin, limits.ssdGbMax, ' GB', errors, FIELD.ssdGb);

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors,
    spec: {
      gpuTypeId: draft.gpuTypeId,
      // Omitted entirely for `none`, never sent as 0: a server that sees both
      // rejects the request, which is how a bug in this logic surfaces loudly
      // instead of quietly provisioning the wrong thing.
      ...(draft.gpuTypeId === NONE_GPU ? {} : { gpuCount }),
      cpuCores: cpuCores as number,
      ramGb: ramGb as number,
      ssdGb: ssdGb as number,
    },
  };
}

/** True when the draft differs from the machine's current configuration. */
export function isChanged(draft: FormDraft, current: MachineSpec | undefined): boolean {
  if (!current) {
    // Nothing to compare against, so anything entered counts as a change.
    return Object.values(draft).some((value) => value.trim() !== '');
  }
  const currentDraft = draftFromSpec(current);
  if (draft.gpuTypeId !== currentDraft.gpuTypeId) {
    return true;
  }
  // A hidden gpuCount is not part of the comparison: switching to `none` and
  // back must not read as a change on its own.
  if (draft.gpuTypeId !== NONE_GPU && asInt(draft.gpuCount) !== asInt(currentDraft.gpuCount)) {
    return true;
  }
  return (
    asInt(draft.cpuCores) !== asInt(currentDraft.cpuCores) ||
    asInt(draft.ramGb) !== asInt(currentDraft.ramGb) ||
    asInt(draft.ssdGb) !== asInt(currentDraft.ssdGb)
  );
}

/**
 * Guarantees the catalogue offers a way to say "no GPU".
 *
 * The server is supposed to supply it, with the reserved id, so the label is
 * the backend's to word. When it does not, one is synthesised and the caller
 * logs a warning: a form with no way to select no GPU is broken.
 */
export function ensureNoneOption(options: GpuTypeOption[]): {
  options: GpuTypeOption[];
  synthesized: boolean;
} {
  if (options.some((option) => option.gpuTypeId === NONE_GPU)) {
    return { options, synthesized: false };
  }
  return {
    options: [{ gpuTypeId: NONE_GPU, label: 'No GPU', maxCount: 0 }, ...options],
    synthesized: true,
  };
}

function checkRange(
  raw: string,
  min: number,
  max: number,
  unit: string,
  errors: FieldErrors,
  key: FieldKey,
): number | undefined {
  if (raw.trim() === '') {
    errors[key] = 'Required.';
    return undefined;
  }
  const value = asInt(raw);
  if (value === undefined) {
    errors[key] = 'Enter a whole number.';
    return undefined;
  }
  if (value < min || value > max) {
    errors[key] = `Must be between ${min}${unit} and ${max}${unit}.`;
    return undefined;
  }
  return value;
}
