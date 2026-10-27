import { createButton } from "./button";

/** Shared lifecycle for static and generated dialog shells. Native modality
 * keeps focus inside the top dialog and makes the background inert.
 * `canDismiss` returning false keeps the dialog open while work is in flight. */
export function bindDialog(element: HTMLDialogElement, dismiss: () => void, canDismiss: () => boolean = () => true) {
  let opener: HTMLElement | null = null;
  // `close` is dispatched as a task, after close() returns.
  let expectedClose = false;
  const finishClose = (): void => {
    element.classList.add("hidden");
    if (opener?.isConnected) opener.focus();
    opener = null;
  };
  element.setAttribute("aria-modal", "true");
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  // Chromium (and WebView2) honours preventDefault() on `cancel` only once per
  // user activation, so a repeated Escape closes the dialog natively.
  element.addEventListener("close", () => {
    if (expectedClose) { expectedClose = false; return; }
    if (!canDismiss()) {
      element.showModal();
      return;
    }
    finishClose();
    dismiss();
  });
  element.addEventListener("click", (event) => {
    if (event.target === element) dismiss();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(element.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((control) => !control.matches(":disabled") && control.getAttribute("aria-disabled") !== "true" && control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });
  element.querySelector<HTMLButtonElement>(".modal-close")!.addEventListener("click", dismiss);
  return {
    open(initialFocus?: HTMLElement | null) {
      if (!element.open) {
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        element.classList.remove("hidden");
        element.showModal();
      }
      (initialFocus ?? element.querySelector<HTMLElement>(".modal-close"))?.focus();
    },
    close() {
      if (!element.open) return;
      expectedClose = true;
      element.close();
      finishClose();
    },
  };
}

let nextDialogId = 0;

export function createDialog(title: string, dismiss: () => void, cardClass = "", canDismiss: () => boolean = () => true) {
  const element = document.createElement("dialog");
  element.className = "modal";
  const card = document.createElement("div");
  card.className = `modal-card ${cardClass}`.trim();
  const header = document.createElement("header");
  header.className = "modal-head";
  const heading = document.createElement("h2");
  heading.className = "modal-title";
  heading.id = `dialog-title-${++nextDialogId}`;
  heading.textContent = title;
  element.setAttribute("aria-labelledby", heading.id);
  const closeButton = createButton({ label: "Close dialog", variant: "icon", icon: "x", className: "modal-close" });
  header.append(heading, closeButton);
  const body = document.createElement("div");
  body.className = "modal-body";
  card.append(header, body);
  element.append(card);
  return { element, body, heading, ...bindDialog(element, dismiss, canDismiss) };
}
