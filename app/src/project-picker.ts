import { createButton } from "./design-system/button";
import {
  DEFAULT_PROJECT_ICON,
  MAX_PROJECT_NAME_LENGTH,
  PROJECT_ICONS,
  projectKey,
  type LibraryProject,
} from "./projects";

export type ProjectChoice =
  | { kind: "set"; project: LibraryProject }
  | { kind: "clear" }
  | { kind: "edit"; from: LibraryProject; to: LibraryProject };

export interface ProjectPickerOptions {
  assetName: string;
  current: LibraryProject | null;
  projects: LibraryProject[];
}

/** A mask-rendered icon; the SVG comes from /icons/project-<id>.svg via ui.css. */
export function createProjectIcon(icon: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = `project-icon project-icon-${icon}`;
  element.setAttribute("aria-hidden", "true");
  return element;
}

let active: ((choice: ProjectChoice | null) => void) | null = null;

/** Opens the project dialog and resolves with the user's choice, or null if dismissed. */
export function requestProject(options: ProjectPickerOptions): Promise<ProjectChoice | null> {
  active?.(null);
  const opener = document.activeElement as HTMLElement | null;

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Choose project");
  const card = document.createElement("div");
  card.className = "modal-card project-modal-card";
  const head = document.createElement("div");
  head.className = "modal-head";
  const title = document.createElement("span");
  title.textContent = `Project for ${options.assetName}`;
  title.className = "project-modal-title";
  const closeBtn = createButton({ label: "Close project dialog", variant: "icon", icon: "x", className: "modal-close" });
  head.append(title, closeBtn);
  const body = document.createElement("div");
  body.className = "modal-body";

  const list = document.createElement("div");
  list.className = "project-list";
  list.setAttribute("role", "list");
  const form = document.createElement("form");
  form.className = "project-form";
  form.noValidate = true;
  const formTitle = document.createElement("strong");
  const nameLabel = document.createElement("label");
  nameLabel.className = "ctl";
  const nameCaption = document.createElement("span");
  nameCaption.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = MAX_PROJECT_NAME_LENGTH;
  nameInput.autocomplete = "off";
  nameLabel.append(nameCaption, nameInput);
  const iconGroup = document.createElement("div");
  iconGroup.className = "project-icon-grid";
  iconGroup.setAttribute("role", "radiogroup");
  iconGroup.setAttribute("aria-label", "Project icon");
  const error = document.createElement("div");
  error.className = "field-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancelEdit = createButton({ label: "Cancel edit", variant: "ghost", className: "hidden" });
  const submit = createButton({ label: "Create and assign", variant: "primary" });
  submit.type = "submit";
  actions.append(cancelEdit, submit);
  const hint = document.createElement("div");
  hint.className = "muted";
  hint.setAttribute("aria-live", "polite");
  form.append(formTitle, nameLabel, hint, iconGroup, error, actions);

  let selectedIcon: string = DEFAULT_PROJECT_ICON;
  let editing: LibraryProject | null = null;
  const iconButtons = new Map<string, HTMLButtonElement>();
  const chooseIcon = (icon: string): void => {
    selectedIcon = icon;
    for (const [id, button] of iconButtons) button.setAttribute("aria-checked", String(id === icon));
  };
  for (const icon of PROJECT_ICONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-icon-choice";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", icon);
    button.title = icon;
    button.append(createProjectIcon(icon));
    button.addEventListener("click", () => chooseIcon(icon));
    iconButtons.set(icon, button);
    iconGroup.append(button);
  }

  const setSubmitLabel = (label: string): void => {
    submit.textContent = label;
    submit.setAttribute("aria-label", label);
  };
  const setMode = (project: LibraryProject | null): void => {
    editing = project;
    formTitle.textContent = project ? `Edit ${project.name}` : "New project";
    setSubmitLabel(project ? "Save changes" : "Create and assign");
    cancelEdit.classList.toggle("hidden", !project);
    nameInput.value = project?.name ?? "";
    chooseIcon(project?.icon ?? DEFAULT_PROJECT_ICON);
    error.textContent = "";
    hint.textContent = "";
  };

  return new Promise<ProjectChoice | null>((resolve) => {
    const finish = (choice: ProjectChoice | null): void => {
      if (active !== finish) return;
      active = null;
      modal.remove();
      resolve(choice);
      if (opener && document.contains(opener)) opener.focus();
    };
    active = finish;

    const addRow = (label: string, project: LibraryProject | null, selected: boolean): void => {
      const row = document.createElement("div");
      row.className = "project-row";
      row.setAttribute("role", "listitem");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = `project-option${selected ? " selected" : ""}`;
      pick.setAttribute("aria-pressed", String(selected));
      const text = document.createElement("span");
      text.textContent = label;
      pick.append(createProjectIcon(project?.icon ?? "none"), text);
      pick.addEventListener("click", () => finish(project ? { kind: "set", project } : { kind: "clear" }));
      row.append(pick);
      if (project) {
        const edit = createButton({ label: `Edit project ${project.name}`, variant: "icon", size: "sm", icon: "pencil-simple" });
        edit.addEventListener("click", () => { setMode(project); nameInput.focus(); nameInput.select(); });
        row.append(edit);
      }
      list.append(row);
    };
    addRow("No project", null, options.current === null);
    for (const project of options.projects) {
      addRow(project.name, project, options.current !== null && projectKey(options.current) === projectKey(project));
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      const fail = (message: string): void => {
        error.textContent = message;
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
      };
      if (!name) return fail("Enter a project name.");
      const found = options.projects.find((project) => projectKey(project) === name.toLocaleLowerCase());
      if (found && !editing) return fail("A project with that name already exists.");
      // Matching the project being edited is just a case or icon change, not a merge.
      const clash = found && editing && projectKey(found) === projectKey(editing) ? undefined : found;
      // Renaming onto an existing project merges into it and adopts its icon, which also lets an interrupted rename finish.
      const project = clash && editing ? { ...clash } : { name, icon: selectedIcon };
      finish(editing ? { kind: "edit", from: editing, to: project } : { kind: "set", project });
    });
    nameInput.addEventListener("input", () => {
      error.textContent = "";
      nameInput.removeAttribute("aria-invalid");
      const clash = editing && options.projects.find((project) => projectKey(project) === nameInput.value.trim().toLocaleLowerCase());
      const merging = clash && projectKey(clash) !== projectKey(editing as LibraryProject) ? clash : undefined;
      hint.textContent = merging ? `Merges into the existing project "${merging.name}".` : "";
      setSubmitLabel(editing ? (merging ? `Merge into ${merging.name}` : "Save changes") : "Create and assign");
    });
    cancelEdit.addEventListener("click", () => setMode(null));
    closeBtn.addEventListener("click", () => finish(null));
    modal.addEventListener("click", (event) => { if (event.target === modal) finish(null); });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); finish(null); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>("button, input"))
        .filter((element) => !(element as HTMLButtonElement).disabled && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    setMode(null);
    body.append(list, form);
    card.append(head, body);
    modal.append(card);
    document.body.append(modal);
    requestAnimationFrame(() => (list.querySelector<HTMLElement>(".project-option.selected") ?? nameInput).focus());
  });
}
