// Settings page: shows the resolved config and lets the user adjust the bits
// that make sense per environment. In Tauri, saving hands the config to the shell
// (which restarts the server); in the browser we only expose host/port.

import { loadConfig, saveConfig } from "./config";
import { destroySelect, enhanceSelect } from "./design-system/select";
import {
  allowsGenerationAboveRecommendation,
  describeHardware,
  detectGenerationHardware,
  setAllowsGenerationAboveRecommendation,
  type GenerationHardwareProfile,
} from "./hardware-profile";
import { appVersion, invoke, isTauri, logsDir, openLogsDir, openOutputDir, pickDirectory } from "./tauri";

export type ProgressDisplayMode = "notification" | "sidebar";
export const PROGRESS_DISPLAY_MODE_KEY = "polyloom.progress-display-mode";

export function progressDisplayMode(): ProgressDisplayMode {
  return localStorage.getItem(PROGRESS_DISPLAY_MODE_KEY) === "sidebar" ? "sidebar" : "notification";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let activeSettingsSection = "settings-general";

function bindSettingsTabs(body: HTMLElement): void {
  const tabs = Array.from(body.querySelectorAll<HTMLButtonElement>("[role=tab]"));
  const panels = Array.from(body.querySelectorAll<HTMLElement>("[role=tabpanel]"));
  const initialTab = tabs.find((tab) => tab.getAttribute("aria-controls") === activeSettingsSection) ?? tabs[0];

  const activate = (tab: HTMLButtonElement, focus = false) => {
    const panelId = tab.getAttribute("aria-controls");
    if (!panelId) return;
    activeSettingsSection = panelId;
    tabs.forEach((candidate) => {
      const selected = candidate === tab;
      candidate.classList.toggle("active", selected);
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== panelId));
    if (focus) tab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activate(tabs[nextIndex], true);
    });
  });
  if (initialTab) activate(initialTab);
}

function replaceSettingsContent(body: HTMLElement, html: string): void {
  const runtimeStatus = body.querySelector<HTMLElement>(".settings-runtime");
  body.querySelectorAll<HTMLSelectElement>("select").forEach(destroySelect);
  body.innerHTML = html;
  const runtimeSlot = body.querySelector<HTMLElement>("[data-settings-runtime-slot]");
  if (runtimeStatus && runtimeSlot) {
    runtimeStatus.classList.remove("hidden");
    runtimeSlot.replaceWith(runtimeStatus);
  }
  body.querySelectorAll<HTMLSelectElement>("select").forEach(enhanceSelect);
  bindSettingsTabs(body);
}

function progressDisplayField(): string {
  const selected = progressDisplayMode();
  return `<div class="ctl">
    <label for="set-progress-display">Generation progress</label>
    <select id="set-progress-display">
      <option value="notification"${selected === "notification" ? " selected" : ""}>Notification</option>
      <option value="sidebar"${selected === "sidebar" ? " selected" : ""}>Right sidebar</option>
    </select>
  </div>`;
}

function bindProgressDisplay(body: HTMLElement): void {
  const select = body.querySelector<HTMLSelectElement>("#set-progress-display");
  if (!select) return;
  select.onchange = () => {
    const mode: ProgressDisplayMode = select.value === "sidebar" ? "sidebar" : "notification";
    localStorage.setItem(PROGRESS_DISPLAY_MODE_KEY, mode);
    window.dispatchEvent(new CustomEvent("polyloom-progress-display", { detail: mode }));
  };
}

function hardwareRecommendationField(profile: GenerationHardwareProfile): string {
  const allowed = allowsGenerationAboveRecommendation();
  return `<div class="settings-hardware settings-field-wide">
    <div class="settings-hardware-copy">
      <strong>Generation recommendation</strong>
      <span>${escapeHtml(describeHardware(profile))}</span>
      <span>Recommended maximum: ${profile.recommendedMaxResolution}</span>
    </div>
    <label class="settings-hardware-override">
      <input id="set-hardware-override" type="checkbox"${allowed ? " checked" : ""} />
      <span>Allow settings above this recommendation</span>
    </label>
    <p>Experimental settings can be much slower and may run out of GPU memory.</p>
  </div>`;
}

function bindHardwareRecommendation(body: HTMLElement): void {
  const checkbox = body.querySelector<HTMLInputElement>("#set-hardware-override");
  if (!checkbox) return;
  checkbox.onchange = () => {
    setAllowsGenerationAboveRecommendation(checkbox.checked);
    window.dispatchEvent(new CustomEvent("polyloom-hardware-policy"));
  };
}

function field(label: string, id: string, value: string, type = "text", wide = false): string {
  return `<label class="ctl${wide ? " settings-field-wide" : ""}"><span>${label}</span>
    <input id="${id}" type="${type}" value="${escapeHtml(value)}" /></label>`;
}

/** Text field with a folder picker and an Open button. */
function dirField(label: string, id: string, value: string): string {
  return `<label class="ctl settings-field-wide"><span>${label}</span>
    <div class="dir-row">
      <input id="${id}" type="text" value="${escapeHtml(value)}" />
      <button id="${id}-browse" class="button button--secondary button--sm" type="button">Browse…</button>
      <button id="${id}-open" class="button button--secondary button--sm" type="button">Open</button>
    </div></label>`;
}

function meta(label: string, value: string): string {
  return `<div class="settings-meta-item"><span>${label}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function sectionNav(items: Array<{ id: string; label: string }>): string {
  return `<div class="settings-section-nav" role="tablist" aria-label="Settings sections">
    ${items.map((item, index) => `<button id="${item.id}-tab" type="button" role="tab" aria-controls="${item.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${item.label}</button>`).join("")}
  </div>`;
}

function section(id: string, title: string, description: string, content: string): string {
  return `<section id="${id}" class="settings-section" role="tabpanel" aria-labelledby="${id}-tab">
    <div class="settings-section-heading">
      <h2>${title}</h2>
      <p>${description}</p>
    </div>
    <div class="settings-fields">${content}</div>
  </section>`;
}

export async function renderSettings(
  body: HTMLElement,
  onSaved: () => void,
): Promise<void> {
  const [cfg, hardware, version] = await Promise.all([
    loadConfig(true),
    detectGenerationHardware(),
    isTauri() ? appVersion().catch(() => "unknown") : Promise.resolve("development"),
  ]);

  if (isTauri()) {
    let outputDir = cfg.outputDir;
    if (!outputDir) {
      try {
        outputDir = await invoke<string>("default_output_dir");
      } catch {
        /* leave blank */
      }
    }
    const logDir = await logsDir();

    replaceSettingsContent(body, `
      <div class="settings-layout">
        ${sectionNav([
          { id: "settings-general", label: "General" },
          { id: "settings-generation", label: "Generation" },
          { id: "settings-storage", label: "Storage" },
          { id: "settings-runtime", label: "Runtime" },
          { id: "settings-information", label: "Information" },
        ])}
        <div class="settings-sections">
          ${section(
            "settings-general",
            "General",
            "Choose where ongoing generation activity appears.",
            progressDisplayField(),
          )}
          ${section(
            "settings-generation",
            "Generation",
            "Set the hardware used for generation and control experimental limits.",
            `${hardwareRecommendationField(hardware)}${field("GPU index (<0 = CPU)", "set-gpu", String(cfg.gpu), "number")}`,
          )}
          ${section(
            "settings-storage",
            "Storage",
            "Choose where models, generated assets, and diagnostic logs live.",
            `${field("Models directory", "set-models", cfg.modelsDir, "text", true)}
             ${dirField("Output folder (generated GLBs are saved here)", "set-output", outputDir)}
             <label class="ctl settings-field-wide"><span>Server logs (attach these to bug reports)</span>
               <div class="dir-row">
                 <input id="set-logs" type="text" value="${escapeHtml(logDir)}" readonly />
                 <button id="set-logs-open" class="button button--secondary button--sm" type="button">Open</button>
               </div>
             </label>`,
          )}
          ${section(
            "settings-runtime",
            "Runtime",
            "Configure the local server and restart it after changes.",
            `${field("Port", "set-port", String(cfg.port), "number")}
             <div class="settings-actions settings-field-wide">
               <button id="set-restart" class="button button--secondary" type="button">Restart server</button>
               <button id="set-save" class="button button--primary" type="button">Save &amp; restart</button>
             </div>`,
          )}
          ${section(
            "settings-information",
            "Information",
            "Read-only details for diagnostics and support.",
            `<div data-settings-runtime-slot class="settings-field-wide"></div>
             <div class="settings-meta-grid settings-field-wide">
               ${meta("Triastasis version", version)}
               ${meta("Backend", cfg.backend)}
               ${meta("Server binary", cfg.serverBin)}
             </div>`,
          )}
        </div>
      </div>`);
    bindProgressDisplay(body);
    bindHardwareRecommendation(body);

    (body.querySelector("#set-logs-open") as HTMLButtonElement).onclick = async () => {
      try {
        await openLogsDir();
      } catch (e) {
        alert(`Could not open the logs folder: ${(e as Error).message ?? e}`);
      }
    };

    const outputInput = body.querySelector("#set-output") as HTMLInputElement;
    (body.querySelector("#set-output-browse") as HTMLButtonElement).onclick = async () => {
      const picked = await pickDirectory(outputInput.value.trim());
      if (picked) outputInput.value = picked;
    };
    (body.querySelector("#set-output-open") as HTMLButtonElement).onclick = async () => {
      await saveConfig({ outputDir: outputInput.value.trim() });
      try {
        await openOutputDir();
      } catch (e) {
        alert(`Could not open the output folder: ${(e as Error).message ?? e}`);
      }
    };

    const save = async () => {
      const modelsDir = (body.querySelector("#set-models") as HTMLInputElement).value.trim();
      const gpu = parseInt((body.querySelector("#set-gpu") as HTMLInputElement).value, 10);
      const port = parseInt((body.querySelector("#set-port") as HTMLInputElement).value, 10);
      await saveConfig({
        modelsDir,
        gpu: isNaN(gpu) ? 0 : gpu,
        port: isNaN(port) ? 8080 : port,
        outputDir: outputInput.value.trim(),
      });
      try {
        await invoke("restart_server");
      } catch {
        /* shell will surface its own error; status polling reflects it */
      }
      onSaved();
    };
    (body.querySelector("#set-save") as HTMLButtonElement).onclick = save;
    (body.querySelector("#set-restart") as HTMLButtonElement).onclick = async () => {
      try {
        await invoke("restart_server");
      } catch {
        /* ignore */
      }
      onSaved();
    };
  } else {
    replaceSettingsContent(body, `
      <div class="settings-layout">
        ${sectionNav([
          { id: "settings-general", label: "General" },
          { id: "settings-generation", label: "Generation" },
          { id: "settings-connection", label: "Connection" },
          { id: "settings-information", label: "Information" },
        ])}
        <div class="settings-sections">
          ${section(
            "settings-general",
            "General",
            "Choose where ongoing generation activity appears.",
            progressDisplayField(),
          )}
          ${section(
            "settings-generation",
            "Generation",
            "Control experimental limits for this browser and detected hardware.",
            hardwareRecommendationField(hardware),
          )}
          ${section(
            "settings-connection",
            "Connection",
            "Connect to a trellis-server that you launched locally.",
            `${field("Host", "set-host", cfg.host)}
             ${field("Port", "set-port", String(cfg.port), "number")}
             <div class="settings-actions settings-field-wide">
               <button id="set-save" class="button button--primary" type="button">Save</button>
             </div>`,
          )}
          ${section(
            "settings-information",
            "Information",
            "Read-only details for diagnostics and support.",
            `<div data-settings-runtime-slot class="settings-field-wide"></div>
             <div class="settings-meta-grid settings-field-wide">
               ${meta("Triastasis version", version)}
               ${meta("Mode", "Browser")}
             </div>`,
          )}
        </div>
      </div>`);
    bindProgressDisplay(body);
    bindHardwareRecommendation(body);
    (body.querySelector("#set-save") as HTMLButtonElement).onclick = async () => {
      const host = (body.querySelector("#set-host") as HTMLInputElement).value.trim() || "127.0.0.1";
      const port = parseInt((body.querySelector("#set-port") as HTMLInputElement).value, 10);
      await saveConfig({ host, port: isNaN(port) ? 8080 : port });
      onSaved();
    };
  }
}
