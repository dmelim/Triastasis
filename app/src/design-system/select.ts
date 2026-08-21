// Accessible custom select built on top of native <select> elements.
// The native element stays the source of truth: options, value, and disabled
// state drive the visual trigger, selections dispatch real input/change events,
// and programmatic value/disabled writes are intercepted so the UI stays in
// sync without touching callers. The open listbox renders in a body-level
// popover so panel scroll containers cannot clip it.

export interface SelectHandle {
  select: HTMLSelectElement;
  trigger: HTMLButtonElement;
}

interface SelectController {
  select: HTMLSelectElement;
  trigger: HTMLButtonElement;
  valueLabel: HTMLSpanElement;
  popover: HTMLDivElement;
  listbox: HTMLDivElement;
  optionEls: HTMLDivElement[];
  activeIndex: number;
  typeAhead: string;
  typeAheadTimer: number | null;
  observer: MutationObserver;
  isOpen: boolean;
  listboxId: string;
  labelId: string;
  originalTabIndex: number;
  onTriggerKeyDown: (event: KeyboardEvent) => void;
  onTriggerClick: () => void;
  onNativeFocus: () => void;
  onGlobalPointerDown: (event: PointerEvent) => void;
  onReposition: () => void;
}

const controllers = new WeakMap<HTMLSelectElement, SelectController>();
let idCounter = 0;

interface NativeAccessor<T> {
  get: (element: HTMLSelectElement) => T;
  set: (element: HTMLSelectElement, value: T) => void;
}

interface NativeAccessors {
  value: NativeAccessor<string>;
  disabled: NativeAccessor<boolean>;
}

let cachedAccessors: NativeAccessors | null = null;

function captureAccessor<T>(name: string): NativeAccessor<T> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, name);
  const get = descriptor?.get;
  const set = descriptor?.set;
  if (!descriptor || typeof get !== "function" || typeof set !== "function") {
    throw new Error(
      `This WebView does not expose native select "${name}" accessors; the custom select cannot stay in sync`,
    );
  }
  return {
    get: (element) => get.call(element) as T,
    set: (element, value) => {
      set.call(element, value);
    },
  };
}

function nativeAccessors(): NativeAccessors {
  if (!cachedAccessors) {
    cachedAccessors = {
      value: captureAccessor<string>("value"),
      disabled: captureAccessor<boolean>("disabled"),
    };
  }
  return cachedAccessors;
}

function readNativeValue(select: HTMLSelectElement): string {
  return nativeAccessors().value.get(select);
}

function writeNativeValue(select: HTMLSelectElement, value: string): void {
  nativeAccessors().value.set(select, value);
}

function readNativeDisabled(select: HTMLSelectElement): boolean {
  return nativeAccessors().disabled.get(select);
}

function writeNativeDisabled(select: HTMLSelectElement, value: boolean): void {
  nativeAccessors().disabled.set(select, value);
}

function selectedText(select: HTMLSelectElement): string {
  const option = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  return option ? option.text : "";
}

function isPlaceholderOption(select: HTMLSelectElement): boolean {
  const option = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  return Boolean(option && option.disabled);
}

/** Mirrors the native select's accessibility state onto the visible trigger. */
function syncAccessibilityState(ctrl: SelectController): void {
  const { select, trigger } = ctrl;
  const describedBy = select.getAttribute("aria-describedby");
  if (describedBy) trigger.setAttribute("aria-describedby", describedBy);
  else trigger.removeAttribute("aria-describedby");
  const invalid = select.getAttribute("aria-invalid") === "true";
  trigger.setAttribute("aria-invalid", invalid ? "true" : "false");
  trigger.classList.toggle("is-invalid", invalid);
  const required = select.required || select.getAttribute("aria-required") === "true";
  if (required) trigger.setAttribute("aria-required", "true");
  else trigger.removeAttribute("aria-required");
}

function syncFromNative(ctrl: SelectController): void {
  const select = ctrl.select;
  const disabled = readNativeDisabled(select);
  ctrl.trigger.setAttribute("aria-disabled", String(disabled));
  ctrl.trigger.classList.toggle("is-disabled", disabled);
  ctrl.trigger.tabIndex = disabled ? -1 : 0;
  ctrl.valueLabel.textContent = selectedText(select);
  ctrl.valueLabel.title = ctrl.isOpen ? "" : ctrl.valueLabel.textContent;
  ctrl.trigger.classList.toggle("is-placeholder", !disabled && isPlaceholderOption(select));
  syncAccessibilityState(ctrl);
}

function buildOptions(ctrl: SelectController): void {
  const { listbox, select } = ctrl;
  listbox.innerHTML = "";
  ctrl.optionEls = [];
  const controlDisabled = readNativeDisabled(select);
  Array.from(select.options).forEach((option, index) => {
    const row = document.createElement("div");
    row.className = "ds-select-option";
    row.id = `${ctrl.listboxId}-opt-${index}`;
    row.setAttribute("role", "option");
    row.dataset.index = String(index);
    if (option.selected) {
      row.classList.add("is-selected");
      row.setAttribute("aria-selected", "true");
    } else {
      row.setAttribute("aria-selected", "false");
    }
    if (option.disabled || controlDisabled) {
      row.setAttribute("aria-disabled", "true");
      row.classList.add("is-disabled");
    }
    const label = document.createElement("span");
    label.className = "ds-select-option-label";
    label.textContent = option.text;
    const check = document.createElement("span");
    check.className = "ds-select-option-check";
    check.setAttribute("aria-hidden", "true");
    row.append(label, check);
    row.title = option.text;

    row.addEventListener("pointerenter", () => {
      if (!row.classList.contains("is-disabled")) setActive(ctrl, index, false);
    });
    row.addEventListener("click", () => {
      if (!row.classList.contains("is-disabled")) {
        choose(ctrl, index);
        close(ctrl, true);
      }
    });
    listbox.appendChild(row);
    ctrl.optionEls.push(row);
  });
  if (!select.options.length) {
    const empty = document.createElement("div");
    empty.className = "ds-select-empty";
    empty.textContent = "No options";
    listbox.appendChild(empty);
  }
}

function setActive(ctrl: SelectController, index: number, scroll = true): void {
  const count = ctrl.select.options.length;
  if (!count) return;
  ctrl.activeIndex = ((index % count) + count) % count;
  ctrl.optionEls.forEach((el, i) => el.classList.toggle("is-active", i === ctrl.activeIndex));
  const active = ctrl.optionEls[ctrl.activeIndex];
  if (active) {
    ctrl.listbox.setAttribute("aria-activedescendant", active.id);
    ctrl.trigger.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }
}

function stepActive(ctrl: SelectController, direction: 1 | -1): void {
  const options = Array.from(ctrl.select.options);
  const count = options.length;
  if (!count) return;
  let index = ctrl.activeIndex;
  for (let i = 0; i < count; i++) {
    index = (index + direction + count) % count;
    if (!options[index].disabled) break;
  }
  setActive(ctrl, index);
}

function firstEnabled(ctrl: SelectController): number {
  const options = Array.from(ctrl.select.options);
  const index = options.findIndex((option) => !option.disabled);
  return index === -1 ? 0 : index;
}

function lastEnabled(ctrl: SelectController): number {
  const options = Array.from(ctrl.select.options);
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i;
  }
  return Math.max(0, options.length - 1);
}

function choose(ctrl: SelectController, index: number): void {
  const option = ctrl.select.options[index];
  if (!option || option.disabled) return;
  writeNativeValue(ctrl.select, option.value);
  ctrl.optionEls.forEach((el, i) => {
    const selected = i === index;
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-selected", String(selected));
  });
  syncFromNative(ctrl);
  ctrl.select.dispatchEvent(new Event("input", { bubbles: true }));
  ctrl.select.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeAheadMatch(ctrl: SelectController, query: string): number {
  const options = Array.from(ctrl.select.options);
  if (!options.length) return -1;
  const lower = query.toLowerCase();
  let start = ctrl.activeIndex + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < options.length; i++) {
      const index = (start + i) % options.length;
      if (options[index].disabled) continue;
      const text = options[index].text.toLowerCase();
      if (pass === 0 ? text.startsWith(lower) : text.includes(lower)) return index;
    }
    start = 0;
  }
  return -1;
}

function positionPopover(ctrl: SelectController): void {
  const rect = ctrl.trigger.getBoundingClientRect();
  const popover = ctrl.popover;
  popover.style.visibility = "hidden";
  popover.style.maxHeight = "";
  const naturalHeight = popover.offsetHeight;
  const margin = 6;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openBelow = spaceBelow >= Math.min(naturalHeight, 180) || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(120, openBelow ? spaceBelow : spaceAbove);
  popover.style.maxHeight = `${Math.floor(maxHeight)}px`;
  const height = Math.min(naturalHeight, maxHeight);
  const width = Math.max(rect.width, 180);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(openBelow ? rect.bottom + 4 : rect.top - height - 4)}px`;
  popover.style.visibility = "";
}

function handlerRef(ctrl: SelectController): (event: PointerEvent) => void {
  return (event: PointerEvent) => {
    const target = event.target as Node;
    if (!ctrl.popover.contains(target) && !ctrl.trigger.contains(target)) close(ctrl, false);
  };
}

function open(ctrl: SelectController): void {
  if (ctrl.isOpen || readNativeDisabled(ctrl.select)) return;
  buildOptions(ctrl);
  ctrl.isOpen = true;
  ctrl.activeIndex = Math.max(0, ctrl.select.selectedIndex);
  ctrl.popover.classList.remove("hidden");
  ctrl.trigger.classList.add("is-open");
  ctrl.trigger.setAttribute("aria-expanded", "true");
  positionPopover(ctrl);
  setActive(ctrl, ctrl.activeIndex);
  ctrl.valueLabel.title = "";
  document.addEventListener("pointerdown", ctrl.onGlobalPointerDown, true);
}

function close(ctrl: SelectController, restoreFocus: boolean): void {
  if (!ctrl.isOpen) return;
  ctrl.isOpen = false;
  ctrl.popover.classList.add("hidden");
  ctrl.trigger.classList.remove("is-open");
  ctrl.trigger.removeAttribute("aria-activedescendant");
  document.removeEventListener("pointerdown", ctrl.onGlobalPointerDown, true);
  if (ctrl.typeAheadTimer !== null) {
    window.clearTimeout(ctrl.typeAheadTimer);
    ctrl.typeAheadTimer = null;
  }
  ctrl.typeAhead = "";
  syncFromNative(ctrl);
  if (restoreFocus && ctrl.trigger.tabIndex >= 0) ctrl.trigger.focus();
}

function handleTriggerKeyDown(ctrl: SelectController, event: KeyboardEvent): void {
  const key = event.key;
  if (!ctrl.isOpen) {
    if (key === "Enter" || key === " " || key === "Spacebar" || key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      open(ctrl);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      open(ctrl);
      ctrl.typeAhead = key.toLowerCase();
      const match = typeAheadMatch(ctrl, ctrl.typeAhead);
      if (match >= 0) setActive(ctrl, match);
    }
    return;
  }
  switch (key) {
    case "ArrowDown":
      event.preventDefault();
      stepActive(ctrl, 1);
      return;
    case "ArrowUp":
      event.preventDefault();
      stepActive(ctrl, -1);
      return;
    case "Home":
      event.preventDefault();
      setActive(ctrl, firstEnabled(ctrl));
      return;
    case "End":
      event.preventDefault();
      setActive(ctrl, lastEnabled(ctrl));
      return;
    case "Enter": {
      event.preventDefault();
      const option = ctrl.select.options[ctrl.activeIndex];
      if (option && !option.disabled) {
        choose(ctrl, ctrl.activeIndex);
        close(ctrl, true);
      }
      return;
    }
    case "Escape":
      event.preventDefault();
      close(ctrl, false);
      return;
    case "Tab":
      close(ctrl, false);
      return;
    default:
      if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (ctrl.typeAheadTimer !== null) window.clearTimeout(ctrl.typeAheadTimer);
        ctrl.typeAhead += key.toLowerCase();
        const match = typeAheadMatch(ctrl, ctrl.typeAhead);
        if (match >= 0) setActive(ctrl, match);
        ctrl.typeAheadTimer = window.setTimeout(() => {
          ctrl.typeAhead = "";
          ctrl.typeAheadTimer = null;
        }, 600);
      }
  }
}

/** Turns a native <select> into the shared custom dropdown. Idempotent. */
export function enhanceSelect(element: HTMLSelectElement | null): SelectHandle | null {
  if (!element) return null;
  const existing = controllers.get(element);
  if (existing) return { select: existing.select, trigger: existing.trigger };

  // The visible combobox is named by the field's <label for=...>, never by a
  // generic "Options" label. The listbox shares that same name.
  let label: HTMLLabelElement | null = element.id
    ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)
    : null;
  let labelId = label?.id ?? "";
  if (!labelId) {
    if (label) {
      labelId = `${element.id || `ds-select-${++idCounter}`}-label`;
      label.id = labelId;
    } else {
      // No explicit field label exists; fall back to an accessible name from
      // the select's aria-label so it is still announced meaningfully.
      labelId = "";
    }
  }

  const listboxId = `ds-select-list-${++idCounter}`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ds-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", listboxId);
  if (labelId) {
    trigger.setAttribute("aria-labelledby", labelId);
  } else if (element.getAttribute("aria-label")) {
    trigger.setAttribute("aria-label", element.getAttribute("aria-label")!);
  }

  const valueLabel = document.createElement("span");
  valueLabel.className = "ds-select-value";
  const icon = document.createElement("span");
  icon.className = "button-icon ds-select-caret";
  icon.setAttribute("aria-hidden", "true");
  trigger.append(valueLabel, icon);

  const popover = document.createElement("div");
  popover.className = "ds-select-popover hidden";
  const listbox = document.createElement("div");
  listbox.className = "ds-select-listbox";
  listbox.id = listboxId;
  listbox.setAttribute("role", "listbox");
  if (labelId) listbox.setAttribute("aria-labelledby", labelId);
  popover.appendChild(listbox);

  element.classList.add("ds-select-native");
  const originalTabIndex = element.tabIndex;
  element.tabIndex = -1;
  element.insertAdjacentElement("afterend", trigger);
  document.body.appendChild(popover);

  const observer = new MutationObserver(() => {
    const current = controllers.get(element);
    if (!current) return;
    if (current.isOpen) buildOptions(current);
    syncFromNative(current);
  });
  observer.observe(element, {
    attributes: true,
    attributeFilter: [
      "aria-invalid",
      "aria-describedby",
      "aria-required",
      "required",
      "disabled",
    ],
    childList: true,
    subtree: true,
  });

  const ctrl: SelectController = {
    select: element,
    trigger,
    valueLabel,
    popover,
    listbox,
    optionEls: [],
    activeIndex: 0,
    typeAhead: "",
    typeAheadTimer: null,
    observer,
    isOpen: false,
    listboxId,
    labelId,
    originalTabIndex,
    onTriggerKeyDown: () => undefined,
    onTriggerClick: () => undefined,
    onNativeFocus: () => undefined,
    onGlobalPointerDown: () => undefined,
    onReposition: () => undefined,
  };
  controllers.set(element, ctrl);
  ctrl.onTriggerKeyDown = (event) => handleTriggerKeyDown(ctrl, event);
  ctrl.onTriggerClick = () => (ctrl.isOpen ? close(ctrl, true) : open(ctrl));
  ctrl.onNativeFocus = () => {
    if (readNativeDisabled(element)) return;
    if (document.activeElement === element) trigger.focus();
  };
  ctrl.onGlobalPointerDown = handlerRef(ctrl);
  ctrl.onReposition = () => {
    if (ctrl.isOpen) positionPopover(ctrl);
  };

  trigger.addEventListener("keydown", ctrl.onTriggerKeyDown);
  trigger.addEventListener("click", ctrl.onTriggerClick);
  element.addEventListener("focus", ctrl.onNativeFocus);

  const valueDescriptor: PropertyDescriptor = {
    configurable: true,
    get(this: HTMLSelectElement) {
      return readNativeValue(this);
    },
    set(this: HTMLSelectElement, next: string) {
      writeNativeValue(this, next);
      const c = controllers.get(this);
      if (c && !c.isOpen) syncFromNative(c);
    },
  };
  const disabledDescriptor: PropertyDescriptor = {
    configurable: true,
    get(this: HTMLSelectElement) {
      return readNativeDisabled(this);
    },
    set(this: HTMLSelectElement, next: boolean) {
      writeNativeDisabled(this, next);
      const c = controllers.get(this);
      if (c) syncFromNative(c);
    },
  };
  Object.defineProperty(element, "value", valueDescriptor);
  Object.defineProperty(element, "disabled", disabledDescriptor);

  window.addEventListener("resize", ctrl.onReposition);
  window.addEventListener("scroll", ctrl.onReposition, true);

  syncFromNative(ctrl);
  return { select: element, trigger };
}

/** Sets the value through the native element and syncs the visible trigger. */
export function setSelectValue(element: HTMLSelectElement, value: string): void {
  const ctrl = controllers.get(element);
  writeNativeValue(element, value);
  if (ctrl && !ctrl.isOpen) syncFromNative(ctrl);
}

/** Rebuilds the trigger and pending listbox after options were replaced. */
export function refreshSelect(element: HTMLSelectElement): void {
  const ctrl = controllers.get(element);
  if (!ctrl) return;
  if (ctrl.isOpen) {
    buildOptions(ctrl);
    setActive(ctrl, Math.max(0, element.selectedIndex));
  }
  syncFromNative(ctrl);
}

/** Removes the custom UI and restores the untouched native select. */
export function destroySelect(element: HTMLSelectElement): void {
  const ctrl = controllers.get(element);
  if (!ctrl) return;
  close(ctrl, false);
  ctrl.observer.disconnect();
  ctrl.trigger.removeEventListener("keydown", ctrl.onTriggerKeyDown);
  ctrl.trigger.removeEventListener("click", ctrl.onTriggerClick);
  element.removeEventListener("focus", ctrl.onNativeFocus);
  ctrl.trigger.remove();
  ctrl.popover.remove();
  window.removeEventListener("resize", ctrl.onReposition);
  window.removeEventListener("scroll", ctrl.onReposition, true);
  delete (element as Partial<HTMLSelectElement>).value;
  delete (element as Partial<HTMLSelectElement>).disabled;
  element.classList.remove("ds-select-native");
  element.tabIndex = ctrl.originalTabIndex;
  controllers.delete(element);
}
