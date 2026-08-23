/**
 * The machine form's webview script.
 *
 * Bundled separately from the extension and loaded with a nonce. It imports the
 * shared rules from src/core/machineForm so the renderer and the extension
 * cannot disagree about what is valid — the extension still validates again
 * before sending, because a webview is not a trustworthy input source.
 */
import {
  EMPTY_DRAFT,
  FIELD,
  NONE_GPU,
  asInt,
  draftFromSpec,
  isChanged,
  maxCountFor,
  nearestScaleIndex,
  sliderScale,
  validate,
  type FieldErrors,
  type FormDraft,
  type GpuTypeOption,
  type Limits,
  type MachineSpec,
} from '../core/machineForm';

interface InitMessage {
  type: 'init';
  status: 'loading' | 'unconfigured' | 'error' | 'ready';
  message?: string;
  stale?: boolean;
  readOnly?: boolean;
  /** Set while a change is in flight; carries the cancel deadline in local time. */
  pending?: { changeId: string; cancellableUntilLocalMs?: number };
  gpuTypes?: GpuTypeOption[];
  limits?: Limits;
  current?: MachineSpec;
  draft?: FormDraft;
}

type HostMessage =
  | InitMessage
  | { type: 'busy'; value: boolean }
  | { type: 'result'; ok: boolean; error?: string; fieldErrors?: FieldErrors };

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLDivElement;

let options: GpuTypeOption[] = [];
let limits: Limits | undefined;
let current: MachineSpec | undefined;
let draft: FormDraft = { ...EMPTY_DRAFT };
let serverErrors: FieldErrors = {};
let touched = new Set<string>();
let busy = false;
let readOnly = false;
/** Kept so typing can update the buttons without rebuilding the DOM under the cursor. */
let applyButton: HTMLButtonElement | undefined;
let pending: InitMessage['pending'];
let countdownTimer: ReturnType<typeof setInterval> | undefined;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      applyInit(message);
      break;
    case 'busy':
      busy = message.value;
      render();
      break;
    case 'result':
      serverErrors = message.fieldErrors ?? {};
      if (message.ok) {
        touched = new Set();
      }
      render(message.error);
      break;
  }
});

function applyInit(message: InitMessage): void {
  if (message.status !== 'ready') {
    renderStatus(message);
    return;
  }
  options = message.gpuTypes ?? [];
  limits = message.limits;
  current = message.current;
  // A saved draft wins over the current configuration: the user was mid-edit.
  draft = message.draft ?? draftFromSpec(message.current);
  readOnly = message.readOnly ?? false;
  pending = message.pending;
  serverErrors = {};
  render();
  if (message.stale) {
    showBanner(
      'These values may be out of date — the server could not be reached. Applying will fail safely if they are.',
    );
  }
}

function renderStatus(message: InitMessage): void {
  root.innerHTML = '';
  const box = el('div', 'status');

  if (message.status === 'loading') {
    box.append(el('p', 'muted', 'Loading…'));
  } else if (message.status === 'unconfigured') {
    box.append(el('p', 'muted', 'Not configured yet.'));
  } else {
    box.append(el('p', 'error-text', message.message ?? "Couldn't load configuration."));
    const retry = el('button', 'primary', 'Retry') as HTMLButtonElement;
    retry.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    box.append(retry);
  }
  root.append(box);
}

function render(formError?: string): void {
  const { errors, spec } = validate(draft, options, limits);
  const visible = visibleErrors(errors);
  const changed = isChanged(draft, current);

  root.innerHTML = '';
  stopCountdown();
  const form = el('form', 'form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(spec);
  });

  form.append(
    selectField({
      key: FIELD.gpuType,
      label: 'GPU type',
      value: draft.gpuTypeId,
      // A retired type is kept as an option so the field is not silently
      // reassigned to something the user did not choose.
      choices: withMissing(options, draft.gpuTypeId),
      error: visible[FIELD.gpuType],
      onChange: (value) => {
        draft = { ...draft, gpuTypeId: value };
        clampGpuCount();
        touch(FIELD.gpuType);
      },
    }),
  );

  // Hidden rather than disabled for `none`: the value stays in the draft, so
  // switching away and back restores what was chosen.
  if (draft.gpuTypeId !== '' && draft.gpuTypeId !== NONE_GPU) {
    const max = maxCountFor(draft.gpuTypeId, options, limits);
    form.append(
      sliderField({
        key: FIELD.gpuCount,
        label: 'Number of GPUs',
        value: draft.gpuCount,
        min: limits?.gpuCountMin ?? 1,
        max,
        // Eight discrete values fit a slider exactly, so there is nothing a
        // text box would add — and the slider makes an out-of-range value
        // unrepresentable rather than merely rejected.
        withInput: false,
        error: visible[FIELD.gpuCount],
        onChange: (value) => {
          draft = { ...draft, gpuCount: value };
          touch(FIELD.gpuCount);
        },
      }),
    );
  }

  const bounds = limits ?? undefined;
  form.append(
    sliderField({
      key: FIELD.cpuCores,
      label: 'CPU cores',
      value: draft.cpuCores,
      min: bounds?.cpuCoresMin ?? 1,
      max: bounds?.cpuCoresMax ?? 256,
      error: visible[FIELD.cpuCores],
      onChange: (value) => {
        draft = { ...draft, cpuCores: value };
      },
    }),
    sliderField({
      key: FIELD.ramGb,
      label: 'RAM (GB)',
      value: draft.ramGb,
      min: bounds?.ramGbMin ?? 1,
      max: bounds?.ramGbMax ?? 2048,
      error: visible[FIELD.ramGb],
      onChange: (value) => {
        draft = { ...draft, ramGb: value };
      },
    }),
    sliderField({
      key: FIELD.ssdGb,
      label: 'SSD (GB)',
      value: draft.ssdGb,
      min: bounds?.ssdGbMin ?? 1,
      max: bounds?.ssdGbMax ?? 2048,
      error: visible[FIELD.ssdGb],
      onChange: (value) => {
        draft = { ...draft, ssdGb: value };
      },
    }),
  );

  if (formError) {
    form.append(el('p', 'error-text', formError));
  }

  const actions = el('div', 'actions');
  const apply = el('button', 'primary', '') as HTMLButtonElement;
  apply.type = 'submit';
  applyButton = apply;
  syncActions();
  actions.append(apply);

  if (readOnly && pending) {
    actions.append(cancelButton(pending));
  }

  if (changed && !readOnly) {
    const discard = el('button', 'secondary', 'Discard') as HTMLButtonElement;
    discard.type = 'button';
    discard.addEventListener('click', () => {
      draft = draftFromSpec(current);
      touched = new Set();
      serverErrors = {};
      persist();
      render();
    });
    actions.append(discard);
  }
  form.append(actions);
  root.append(form);

  if (readOnly) {
    root.prepend(el('div', 'banner applying', 'Applying changes to your machine…'));
  }
}

/**
 * Cancel, with a live countdown.
 *
 * The deadline arrives already corrected for the difference between this
 * machine's clock and the server's; a laptop four minutes fast would otherwise
 * never see the button. The countdown is advisory either way — the server
 * decides whether a cancel arrived in time, and losing that race is handled as
 * a normal outcome rather than an error.
 */
function cancelButton(active: NonNullable<InitMessage['pending']>): HTMLButtonElement {
  const button = el('button', 'secondary', 'Cancel') as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    vscode.postMessage({ type: 'cancelChange' });
  });

  const deadline = active.cancellableUntilLocalMs;
  if (deadline === undefined) {
    button.disabled = true;
    button.textContent = 'Cannot be cancelled';
    return button;
  }

  const tick = (): void => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      button.disabled = true;
      button.textContent = 'Too late to cancel';
      stopCountdown();
      return;
    }
    button.textContent = `Cancel (${remaining}s)`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  return button;
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
}

/**
 * Refreshes the Apply button from the current draft without re-rendering.
 *
 * A full render replaces every input, which would take the focus and caret
 * away mid-keystroke. Only the button actually depends on each character, so
 * only the button is updated.
 */
function syncActions(): void {
  if (!applyButton) {
    return;
  }
  const changed = isChanged(draft, current);
  const { spec } = validate(draft, options, limits);
  applyButton.textContent = readOnly
    ? 'Applying changes…'
    : changed
      ? 'Apply changes'
      : 'No changes';
  applyButton.disabled = busy || readOnly || !changed || spec === undefined;
}

/**
 * Errors are shown for fields the user has finished with, or that the server
 * rejected — not while they are still typing. Flagging `1` as invalid on the
 * way to `128` trains people to ignore the error text.
 */
function visibleErrors(errors: FieldErrors): FieldErrors {
  const shown: FieldErrors = { ...serverErrors };
  for (const [key, message] of Object.entries(errors) as Array<[keyof FieldErrors, string]>) {
    if (touched.has(key)) {
      shown[key] = message;
    }
  }
  return shown;
}

function touch(key: string): void {
  touched.add(key);
  persist();
  render();
}

/**
 * Clamps the count down when a type with a smaller maximum is chosen, rather
 * than silently keeping a number that is now invalid.
 */
function clampGpuCount(): void {
  if (draft.gpuTypeId === NONE_GPU || draft.gpuTypeId === '') {
    return;
  }
  const max = maxCountFor(draft.gpuTypeId, options, limits);
  const count = asInt(draft.gpuCount);
  if (count === undefined || count < 1) {
    draft = { ...draft, gpuCount: '1' };
  } else if (count > max) {
    draft = { ...draft, gpuCount: String(max) };
    showBanner(`Reduced to ${max} GPUs, the most this type supports.`);
  }
}

function submit(spec: MachineSpec | undefined): void {
  // Every field is marked touched so a click on a disabled-looking form still
  // explains what is wrong.
  touched = new Set(Object.values(FIELD));
  if (!spec) {
    render();
    return;
  }
  vscode.postMessage({ type: 'apply', spec });
}

function persist(): void {
  vscode.postMessage({ type: 'draft', draft });
}

// -- small DOM helpers -------------------------------------------------------

function selectField(config: {
  key: string;
  label: string;
  value: string;
  choices: Array<{ value: string; label: string }>;
  error?: string | undefined;
  onChange: (value: string) => void;
}): HTMLElement {
  const wrapper = el('div', 'field');
  wrapper.append(labelFor(config.key, config.label));

  const select = document.createElement('select');
  select.id = config.key;
  select.disabled = readOnly || busy;
  for (const choice of config.choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    option.selected = choice.value === config.value;
    select.append(option);
  }
  if (config.value === '') {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose…';
    placeholder.selected = true;
    select.prepend(placeholder);
  }
  select.addEventListener('change', () => config.onChange(select.value));
  wrapper.append(select);
  appendError(wrapper, config.error);
  return wrapper;
}

/**
 * A slider paired with a text box, both bound to the same draft value.
 *
 * The slider is for reaching a shape quickly; the text box is for saying
 * exactly 300 rather than 256. Neither alone is enough: a linear 1..2048
 * slider in a narrow sidebar is about seven values per pixel, and a bare text
 * box makes exploring the range tedious.
 *
 * The text box is `type="text"` with a numeric inputmode rather than
 * `type="number"`, which reports an empty value for unparseable input — so the
 * user cannot be shown what they typed — and silently changes on scroll.
 */
function sliderField(config: {
  key: string;
  label: string;
  value: string;
  min: number;
  max: number;
  withInput?: boolean;
  error?: string | undefined;
  onChange: (value: string) => void;
}): HTMLElement {
  const wrapper = el('div', 'field');
  const header = el('div', 'field-header');
  header.append(labelFor(config.key, config.label));

  const scale = sliderScale(config.min, config.max);
  const parsed = asInt(config.value);
  const disabled = readOnly || busy;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'slider';
  slider.min = '0';
  slider.max = String(Math.max(scale.length - 1, 0));
  slider.step = '1';
  // An off-scale value still positions the handle sensibly without being
  // rewritten: typing 300 leaves 300 alone and parks the handle near 256.
  slider.value = String(nearestScaleIndex(scale, parsed ?? config.min));
  slider.disabled = disabled;
  slider.setAttribute('aria-label', config.label);
  if (scale.length > 2 && scale.length <= 32) {
    slider.setAttribute('list', `${config.key}-ticks`);
  }

  const readout = el('output', 'readout', parsed === undefined ? '—' : String(parsed));
  let valueInput: HTMLInputElement | undefined;

  if (config.withInput === false) {
    header.append(readout);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.className = 'value-input';
    input.id = config.key;
    input.value = config.value;
    input.disabled = disabled;
    input.setAttribute('aria-label', config.label);
    valueInput = input;
    input.addEventListener('input', () => {
      config.onChange(input.value);
      const typed = asInt(input.value);
      if (typed !== undefined) {
        slider.value = String(nearestScaleIndex(scale, typed));
      }
      syncActions();
      persist();
    });
    input.addEventListener('blur', () => touch(config.key));
    header.append(input);
  }

  slider.addEventListener('input', () => {
    const picked = scale[Number(slider.value)] ?? config.min;
    readout.textContent = String(picked);
    if (valueInput) {
      valueInput.value = String(picked);
    }
    config.onChange(String(picked));
    syncActions();
    persist();
  });
  // Committing on release rather than on every pixel keeps validation and the
  // Apply/No-changes state from flickering during a drag.
  slider.addEventListener('change', () => touch(config.key));

  wrapper.append(header, slider);

  if (scale.length > 2 && scale.length <= 32) {
    const ticks = document.createElement('datalist');
    ticks.id = `${config.key}-ticks`;
    for (const [index] of scale.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      ticks.append(option);
    }
    wrapper.append(ticks);
  }

  const range = el('p', 'muted range-hint', `${config.min}–${config.max}`);
  wrapper.append(range);
  appendError(wrapper, config.error);
  return wrapper;
}

function labelFor(key: string, text: string): HTMLElement {
  const label = document.createElement('label');
  label.htmlFor = key;
  label.textContent = text;
  return label;
}

function appendError(wrapper: HTMLElement, error: string | undefined): void {
  if (error) {
    wrapper.append(el('p', 'error-text', error));
  }
}

function withMissing(
  known: GpuTypeOption[],
  selected: string,
): Array<{ value: string; label: string }> {
  const choices = known.map((option) => ({ value: option.gpuTypeId, label: option.label }));
  if (selected !== '' && !known.some((option) => option.gpuTypeId === selected)) {
    choices.unshift({ value: selected, label: `${selected} (no longer available)` });
  }
  return choices;
}

function showBanner(text: string): void {
  const existing = root.querySelector('.banner');
  existing?.remove();
  root.prepend(el('div', 'banner', text));
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

vscode.postMessage({ type: 'ready' });
