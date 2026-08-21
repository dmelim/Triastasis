export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md";
export type ButtonLabelMode = "text" | "aria-only";

export interface ButtonOptions {
  label: string;
  /** "aria-only" keeps the accessible label but renders no visible text,
      for buttons whose content is structured markup (cards, tiles). */
  labelMode?: ButtonLabelMode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  icon?: string;
  title?: string;
  disabled?: boolean;
}

/** Creates the shared native-button primitive used by dynamic UI. */
export function createButton(options: ButtonOptions): HTMLButtonElement {
  const button = document.createElement("button");
  const variant = options.variant ?? "secondary";
  const size = options.size ?? "md";
  const ariaOnly = options.labelMode === "aria-only";
  button.type = "button";
  button.className = [
    "button",
    `button--${variant}`,
    `button--${size}`,
    options.className ?? "",
  ].filter(Boolean).join(" ");
  button.disabled = Boolean(options.disabled);
  button.setAttribute("aria-label", options.label);
  if (options.title ?? options.label) button.title = options.title ?? options.label;

  if (options.icon) {
    const icon = document.createElement("span");
    icon.className = `button-icon icon-${options.icon}`;
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
  } else if (!ariaOnly) {
    button.textContent = options.label;
  }
  return button;
}
