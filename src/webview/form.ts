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
      selectField({
        key: FIELD.gpuCount,
        label: 'Number of GPUs',
        value: draft.gpuCount,
        choices: countChoices(max),
        error: visible[FIELD.gpuCount],
        onChange: (value) => {
          draft = { ...draft, gpuCount: value };
          touch(FIELD.gpuCount);
        },
      }),
    );
  }

  form.append(
    numberField(FIELD.cpuCores, 'CPU cores', draft.cpuCores, visible[FIELD.cpuCores], (value) => {
      draft = { ...draft, cpuCores: value };
    }),
    numberField(FIELD.ramGb, 'RAM (GB)', draft.ramGb, visible[FIELD.ramGb], (value) => {
      draft = { ...draft, ramGb: value };
    }),
    numberField(FIELD.ssdGb, 'SSD (GB)', draft.ssdGb, visible[FIELD.ssdGb], (value) => {
      draft = { ...draft, ssdGb: value };
    }),
  );

  if (formError) {
    form.append(el('p', 'error-text', formError));
  }

  const actions = el('div', 'actions');
  const apply = el(
    'button',
    'primary',
    readOnly ? 'Applying changes…' : changed ? 'Apply changes' : 'No changes',
  ) as HTMLButtonElement;
  apply.type = 'submit';
  apply.disabled = busy || readOnly || !changed || spec === undefined;
  actions.append(apply);

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
 * Text with a numeric inputmode rather than `type="number"`.
 *
 * `type="number"` reports an empty value for unparseable input, so the user
 * cannot be shown what they typed, and its scroll-wheel behaviour silently
 * changes the value when the sidebar is scrolled with the cursor over it.
 */
function numberField(
  key: string,
  label: string,
  value: string,
  error: string | undefined,
  onInput: (value: string) => void,
): HTMLElement {
  const wrapper = el('div', 'field');
  wrapper.append(labelFor(key, label));

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.id = key;
  input.value = value;
  input.disabled = readOnly || busy;
  input.addEventListener('input', () => {
    onInput(input.value);
    persist();
  });
  input.addEventListener('blur', () => touch(key));
  wrapper.append(input);
  appendError(wrapper, error);
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

function countChoices(max: number): Array<{ value: string; label: string }> {
  return Array.from({ length: max }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  }));
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
