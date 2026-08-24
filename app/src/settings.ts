// Settings modal: shows the resolved config and lets the user adjust the bits
// that make sense per environment. In Tauri, saving hands the config to the shell
// (which restarts the server); in the browser we only expose host/port.

import { loadConfig, saveConfig } from "./config";
import {
  allowsGenerationAboveRecommendation,
  describeHardware,
  detectGenerationHardware,
  setAllowsGenerationAboveRecommendation,
  type GenerationHardwareProfile,
} from "./hardware-profile";
import { invoke, isTauri, logsDir, openLogsDir, openOutputDir, pickDirectory } from "./tauri";

export type ProgressDisplayMode = "notification" | "sidebar";
export const PROGRESS_DISPLAY_MODE_KEY = "polyloom.progress-display-mode";

export function progressDisplayMode(): ProgressDisplayMode {
  return localStorage.getItem(PROGRESS_DISPLAY_MODE_KEY) === "sidebar" ? "sidebar" : "notification";
}

function progressDisplayField(): string {
  const selected = progressDisplayMode();
  return `<label class="ctl"><span>Generation progress</span>
    <select id="set-progress-display">
      <option value="notification"${selected === "notification" ? " selected" : ""}>Notification</option>
      <option value="sidebar"${selected === "sidebar" ? " selected" : ""}>Right sidebar</option>
    </select></label>`;
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
  return `<div class="settings-hardware">
    <div class="settings-hardware-copy">
      <strong>Generation recommendation</strong>
      <span>${describeHardware(profile)}</span>
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

function field(label: string, id: string, value: string, type = "text"): string {
  return `<label class="ctl"><span>${label}</span>
    <input id="${id}" type="${type}" value="${value.replace(/"/g, "&quot;")}" /></label>`;
}

/** Text field with a "Browse…" folder picker and an "Open" button. */
function dirField(label: string, id: string, value: string): string {
  return `<label class="ctl"><span>${label}</span>
    <div class="dir-row">
      <input id="${id}" type="text" value="${value.replace(/"/g, "&quot;")}" />
      <button id="${id}-browse" class="button button--secondary button--sm" type="button">Browse…</button>
      <button id="${id}-open" class="button button--secondary button--sm" type="button">Open</button>
    </div></label>`;
}

function ro(label: string, value: string): string {
  return `<div class="kv">${label}: <b>${value || "-"}</b></div>`;
}

export async function renderSettings(
  body: HTMLElement,
  onSaved: () => void,
): Promise<void> {
  const [cfg, hardware] = await Promise.all([loadConfig(true), detectGenerationHardware()]);

  if (isTauri()) {
    // get_config already fills the default output dir; fall back to it when unset
    // (e.g. no config.json yet).
    let outputDir = cfg.outputDir;
    if (!outputDir) {
      try {
        outputDir = await invoke<string>("default_output_dir");
      } catch {
        /* leave blank */
      }
    }
    const logDir = await logsDir();

    body.innerHTML = `
      ${ro("Backend", cfg.backend)}
      ${ro("Server binary", cfg.serverBin)}
      ${progressDisplayField()}
      ${hardwareRecommendationField(hardware)}
      ${field("Models directory", "set-models", cfg.modelsDir)}
      ${dirField("Output folder (generated GLBs are saved here)", "set-output", outputDir)}
      ${field("GPU index (&lt;0 = CPU)", "set-gpu", String(cfg.gpu), "number")}
      ${field("Port", "set-port", String(cfg.port), "number")}
      <label class="ctl"><span>Server logs (each launch is saved here. Attach these to bug reports)</span>
        <div class="dir-row">
          <input id="set-logs" type="text" value="${logDir.replace(/"/g, "&quot;")}" readonly />
          <button id="set-logs-open" class="button button--secondary button--sm" type="button">Open</button>
        </div></label>
      <div class="modal-actions">
        <button id="set-restart" class="button button--secondary" type="button">Restart server</button>
        <button id="set-save" class="button button--primary" type="button">Save &amp; restart</button>
      </div>`;
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
      // persist the (possibly-edited) path first so the shell opens what's shown
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
    body.innerHTML = `
      <div class="kv">Running in a browser. Connecting to a trellis-server you launched.</div>
      ${progressDisplayField()}
      ${hardwareRecommendationField(hardware)}
      ${field("Host", "set-host", cfg.host)}
      ${field("Port", "set-port", String(cfg.port), "number")}
      <div class="modal-actions">
        <button id="set-save" class="button button--primary" type="button">Save</button>
      </div>`;
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
