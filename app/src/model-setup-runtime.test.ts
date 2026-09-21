import test from "node:test";
import assert from "node:assert/strict";
import { refreshModelSetup } from "./model-setup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Classes {
  values = new Set<string>();
  contains(value: string) { return this.values.has(value); }
  remove(value: string) { this.values.delete(value); }
  toggle(value: string, force = !this.contains(value)) {
    if (force) this.values.add(value); else this.values.delete(value);
  }
}

// Minimal DOM boundary: real setup rendering and click handlers run unchanged.
class Button {
  dataset: Record<string, string> = {};
  disabled = false;
  style = { minWidth: "" };
  innerHTML = "";
  label = { textContent: "" };
  onclick: (() => Promise<void>) | null = null;
  getBoundingClientRect() { return { width: 180 }; }
  querySelector() { return this.label; }
  setAttribute() {}
  removeAttribute() {}
}

class Root {
  classList = new Classes();
  buttons: Button[] = [];
  message = { classList: new Classes(), label: { textContent: "" }, querySelector() { return this.label; } };
  markup = "";
  renders = 0;
  set innerHTML(value: string) {
    this.markup = value;
    this.renders++;
    this.message.label.textContent = "";
    this.message.classList.values = new Set(["hidden"]);
    this.buttons = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
      const button = new Button();
      for (const attribute of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
        button.dataset[attribute[1]] = attribute[2];
      }
      button.disabled = /\bdisabled\b/.test(match[1]);
      button.innerHTML = match[2];
      return button;
    });
  }
  get innerHTML() { return this.markup; }
  querySelector(selector: string) { return selector === "#model-setup-message" ? this.message : null; }
  querySelectorAll(selector: string) { return selector === "[data-act]" ? this.buttons : []; }
  setAttribute() {}
  replaceChildren() { this.innerHTML = ""; }
  focus() {}
}

const scan = {
  modelsRoot: "C:/test-models", modelsDir: "C:/test-models/managed", portable: false,
  activeBundle: null, managed: [], custom: null, legacy: null, freeBytes: null,
  catalogVersion: 1, modelRevision: "test",
};
const missingRuntime = {
  installed: false, backend: "", path: "C:/test-runtime", portable: false,
  recommendedBackend: "vulkan", recommendation: "Test GPU",
};

async function settle() {
  // Drain invoke/scan/render continuations without wall-clock delays.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("runtime installation survives a pending render and errors survive polling until retry", async () => {
  const root = new Root();
  let hardwareWait: ReturnType<typeof deferred<null>> | null = null;
  let installation = deferred<typeof missingRuntime>();
  let installCalls = 0;
  let runtime = { ...missingRuntime };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function provide(name: string, value: unknown) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  provide("window", { __TAURI_INTERNALS__: { invoke(command: string) {
    if (command === "scan_models") return Promise.resolve(scan);
    if (command === "runtime_status") return Promise.resolve({ ...runtime });
    if (command === "detect_hardware_info") return hardwareWait?.promise ?? Promise.resolve(null);
    if (command === "install_runtime") { installCalls++; return installation.promise; }
    throw new Error(`Unexpected command: ${command}`);
  } } });
  provide("document", { getElementById: () => root, body: { classList: new Classes() }, querySelectorAll: () => [] });
  provide("localStorage", { getItem: () => "1" });
  try {
    await refreshModelSetup();
    const installButton = root.buttons.find((button) => button.dataset.act === "install-runtime")!;
    assert.ok(installButton);
    hardwareWait = deferred<null>();
    const pendingRefresh = refreshModelSetup();
    await settle();
    const action = installButton.onclick!();
    assert.equal(installCalls, 1, "the first click invokes installation");
    assert.ok(installButton.disabled);
    await installButton.onclick!();
    assert.equal(installCalls, 1, "a repeated click cannot start a second install");
    const rendersAtStart = root.renders;
    hardwareWait.resolve(null);
    await pendingRefresh;
    assert.equal(root.renders, rendersAtStart, "a hardware probe started before the click must not restore the idle screen");
    assert.match(root.message.label.textContent, /Downloading and verifying/);
    assert.ok(root.buttons.every((button) => button.disabled));

    installation.reject(new Error("Test network failure"));
    await action;
    hardwareWait = null;
    await refreshModelSetup();
    assert.equal(root.message.label.textContent, "Test network failure", "polling must retain the error explaining why installation stopped");
    assert.equal(root.message.classList.contains("hidden"), false);

    hardwareWait = deferred<null>();
    const staleHardware = hardwareWait;
    const staleRefresh = refreshModelSetup();
    await settle();
    hardwareWait = null;
    installation = deferred<typeof missingRuntime>();
    const retry = root.buttons.find((button) => button.dataset.act === "install-runtime")!.onclick!();
    assert.equal(installCalls, 2);
    assert.match(root.message.label.textContent, /Downloading and verifying/);
    runtime = { ...missingRuntime, installed: true, backend: "vulkan" };
    installation.resolve(runtime);
    await retry;
    await settle();
    assert.doesNotMatch(root.innerHTML, /data-act="install-runtime"/);
    assert.notEqual(root.message.label.textContent, "Test network failure");
    const rendersAfterInstall = root.renders;
    staleHardware.resolve(null);
    await staleRefresh;
    assert.equal(root.renders, rendersAfterInstall, "a pre-install scan must not replace the ready screen after installation finishes");
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
