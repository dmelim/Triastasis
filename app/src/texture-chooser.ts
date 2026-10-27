import { Viewer } from "./viewer";
import { createDialog } from "./design-system/dialog";
import { createButton } from "./design-system/button";
import { inspectGenerationData, sha256 } from "./generation-data";
import { loadVersionGenerationData, loadVersionModel, createDerivedVersion } from "./store";
import { TextureCache } from "./texture-cache";
import { TextureSession } from "./texture-session";
import { createTexturePreview } from "./texture-preview";
import { retexture, bakeTexture, texturePreview } from "./texture-api";
import { normalizeGenParams, type VersionRecord } from "./types";
import { nativeCapabilities, type NativeProgress } from "./api";
import { parseProject } from "./projects";

export async function openTextureChooser(parent: VersionRecord): Promise<VersionRecord | null> {
  const capabilities = await nativeCapabilities();
  if (capabilities.textureOptionsVersion !== 1) throw new Error("This runtime does not support texture options. Select a compatible runtime in Settings.");
  const reference = parent.generationDataRef;
  if (!reference) throw new Error("Generation data was not saved for this model. Generate a new textured model at 512 resolution.");
  const source = await loadVersionModel(parent);
  if (await sha256(source.glb) !== reference.modelSha256) throw new Error("This model no longer matches its saved surface. Open the original generation to change its texture.");
  const bundle = await loadVersionGenerationData(source), inspected = await inspectGenerationData(bundle);
  if (inspected.reference.sha256 !== reference.sha256) throw new Error("Saved generation data does not match this version");
  const preview = createTexturePreview(await (await inspected.container.entry("surface.mesh")).arrayBuffer(), inspected.container.manifest.double_sided === true);
  const parameters = normalizeGenParams(parent.params);
  const cache = new TextureCache();
  return new Promise<VersionRecord | null>((resolve) => {
    let closing = false, saving = false, view: "preview" | "baked" = "preview", displayed = -1, inspectedBake: Blob | null = null, loadingBake: Blob | null = null;
    let nativeProgress: NativeProgress | null = null;
    let viewer: Viewer | undefined;
    const close = async (result: VersionRecord | null = null) => {
      if (saving || closing) return;
      closing = true;
      await session.close();
      viewer?.dispose(); preview.dispose();
      await cache.dispose().catch(() => {});
      dialog.close(); dialog.element.remove(); resolve(result);
    };
    const dialog = createDialog("Texture options", () => { void close(); }, "texture-options-card", () => !session.busy && !saving);
    const description = document.createElement("p"); description.className = "field-help";
    description.textContent = "Compare three material variations on the same shape. Previews are approximate; bake your selection to inspect fine detail before saving.";
    const mount = document.createElement("div"); mount.className = "texture-options-view";
    const choices = document.createElement("div"); choices.className = "texture-options-choices"; choices.setAttribute("aria-label", "Texture options");
    const status = document.createElement("p"); status.className = "texture-options-status"; status.setAttribute("role", "status");
    const progress = document.createElement("progress"); progress.max = 100; progress.className = "texture-options-progress"; progress.setAttribute("aria-label", "Texture operation progress");
    const detail = document.createElement("p"); detail.className = "field-help";
    const actions = document.createElement("div"); actions.className = "modal-actions";
    const stop = createButton({ label: "Stop", variant: "secondary" });
    const back = createButton({ label: "Back to options", variant: "secondary" });
    const bake = createButton({ label: "Bake selected", variant: "primary" });
    const save = createButton({ label: "Save version", variant: "primary" });
    actions.append(stop, back, bake, save);
    dialog.body.append(description, mount, choices, status, progress, detail, actions);
    document.body.append(dialog.element);
    const session = new TextureSession({
      async option(seed, shouldStart, queuedCancellation) {
        nativeProgress = null; render();
        const result = await retexture(bundle, seed, value => { nativeProgress = value; render(); }, shouldStart, queuedCancellation);
        const data = await texturePreview(result, reference, inspected.container);
        if (data.seed !== seed) throw new Error("The runtime returned a different texture seed");
        const key = await cache.save(result);
        return { ...data, key };
      },
      async bake(option, shouldStart, queuedCancellation) {
        nativeProgress = null; render();
        return bakeTexture(bundle, await cache.read(option.key), parameters.atlasSize === "auto" ? 1024 : parameters.atlasSize,
          parameters.textureEncoding, value => { nativeProgress = value; render(); }, shouldStart, queuedCancellation);
      },
      discard: option => cache.remove(option.key),
      changed: () => { if (viewer) render(); },
    });
    dialog.open();
    try { viewer = new Viewer(mount); viewer.loadRoot(preview.root); }
    catch (error) { status.textContent = error instanceof Error ? error.message : "The texture viewer could not start"; void close(); return; }
    function render() {
      const instance = viewer; if (!instance) return;
      session.options.forEach((option, index) => {
        let choice = choices.children[index] as HTMLButtonElement | undefined;
        if (!choice) {
          choice = createButton({ label: `Seed ${option.seed}`, variant: "secondary" });
          choice.addEventListener("click", () => session.select(index)); choices.append(choice);
        }
        choice.setAttribute("aria-pressed", String(session.selected === index));
        choice.disabled = !session.canSelect || saving || closing;
      });
      if (!closing && session.phase === "baked" && session.baked && inspectedBake !== session.baked && loadingBake !== session.baked) {
        const blob = session.baked; loadingBake = blob; view = "baked";
        save.disabled = true;
        void instance.load(blob, () => { if (closing || session.baked !== blob) throw new Error("Baked inspection was superseded"); })
          .then(() => { if (!closing && session.baked === blob) { inspectedBake = blob; loadingBake = null; render(); } }).catch(error => {
          if (closing || session.baked !== blob) return;
          inspectedBake = null; loadingBake = null; session.error = `Baked inspection failed: ${error instanceof Error ? error.message : error}`;
          save.disabled = true; status.textContent = session.error;
        });
      } else if (session.phase !== "baked" && session.options[session.selected] && (view !== "preview" || displayed !== session.selected)) {
        if (view !== "preview") instance.loadRoot(preview.root);
        view = "preview"; displayed = session.selected; inspectedBake = null; loadingBake = null;
        preview.set(session.options[session.selected].values); instance.setDisplayMode("textured");
      }
      const option = session.options[session.selected];
      const stage = nativeProgress?.stageLabel;
      status.textContent = closing || session.phase === "stopping" ? "Stopping after the current operation…"
        : saving ? "Saving a new Library version…"
        : session.phase === "baking" ? stage || "Baking the selected texture…"
        : session.phase === "generating" ? `Option ${session.attempt || 1} of 3: ${stage || "Waiting for the runtime…"}`
        : session.phase === "baked" ? "Inspect the baked texture, then save it as a new version."
        : session.error || (session.options.length ? "Choose an option and bake it to inspect the finished texture." : "No texture options completed. Close this dialog and try again.");
      detail.textContent = view === "baked" ? "Baked texture. The original Library version will remain available."
        : `Approximate material/color preview. Fine patterns can appear smoother.${option?.missingSamples ? ` ${option.missingSamples} vertices have no material sample.` : ""}${session.error && session.phase === "generating" ? ` ${session.error}` : ""}`;
      progress.hidden = !session.busy;
      if (nativeProgress?.percent === null || !nativeProgress) progress.removeAttribute("value"); else progress.value = nativeProgress.percent;
      stop.hidden = session.phase !== "generating" && session.phase !== "stopping";
      stop.disabled = session.phase === "stopping" || closing;
      back.hidden = session.phase !== "baked";
      back.disabled = saving || closing;
      bake.hidden = session.phase === "baked";
      bake.disabled = !option || session.phase === "baking" || session.phase === "stopping" || closing || saving;
      save.hidden = session.phase !== "baked";
      save.disabled = saving || closing || !inspectedBake || inspectedBake !== session.baked;
    }
    stop.addEventListener("click", () => session.stop());
    back.addEventListener("click", () => { session.back(); displayed = -1; render(); });
    bake.addEventListener("click", () => { void session.bakeSelected(); });
    save.addEventListener("click", async () => {
      const baked = session.baked, selected = session.options[session.selected];
      if (!baked || !selected || saving) return;
      saving = true; render();
      try {
        const project = parseProject(parent.operationParams.project);
        const child = await createDerivedVersion(parent, { glb: baked, generationData: bundle,
          generationDataRef: { ...reference, modelSha256: await sha256(baked) }, operation: "retextured",
          operationParams: { textureSeed: selected.seed, sourceSurfaceSha256: reference.sourceSurfaceSha256,
            ...(project ? { project } : {}), ...(typeof parent.operationParams.assetLabel === "string" ? { assetLabel: parent.operationParams.assetLabel } : {}) },
          favorite: parent.favorite,
          label: `${parent.label} · texture ${selected.seed}` });
        saving = false; await close(child);
      } catch (error) { saving = false; session.error = error instanceof Error ? error.message : "The new version could not be saved"; render(); status.textContent = session.error; }
    });
    const seeds = new Set<number>();
    while (seeds.size < 3) { const value = crypto.getRandomValues(new Uint32Array(1))[0]; if (value) seeds.add(value); }
    render(); void session.start([...seeds]);
  });
}
