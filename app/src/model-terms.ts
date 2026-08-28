import { bindExternalLinks } from "./tauri";

const MODEL_TERMS_STORAGE_KEY = "triastasis.curated-model-terms.accepted.v1";

export function curatedModelTermsAccepted(): boolean {
  try {
    return localStorage.getItem(MODEL_TERMS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCuratedModelTermsAccepted(accepted: boolean): void {
  try {
    if (accepted) localStorage.setItem(MODEL_TERMS_STORAGE_KEY, "1");
    else localStorage.removeItem(MODEL_TERMS_STORAGE_KEY);
  } catch {
    // A download remains blocked when the acknowledgement cannot be saved.
  }
}

export function curatedModelTermsHtml(): string {
  const checked = curatedModelTermsAccepted() ? " checked" : "";
  return `
    <section class="model-terms" id="curated-model-terms" aria-labelledby="curated-model-terms-title">
      <strong id="curated-model-terms-title">Model terms</strong>
      <p>Curated bundles come from ilintar/trellis2-gguf and combine converted weights from several upstream projects. They are not covered by the Triastasis MIT License.</p>
      <p>Review the <a href="https://huggingface.co/ilintar/trellis2-gguf" target="_blank" rel="noreferrer">bundle source</a>, <a href="https://huggingface.co/microsoft/TRELLIS.2-4B" target="_blank" rel="noreferrer">TRELLIS.2 model terms</a>, <a href="https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md" target="_blank" rel="noreferrer">DINOv3 License</a>, and <a href="https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE" target="_blank" rel="noreferrer">BiRefNet License</a>.</p>
      <label class="model-terms-accept">
        <input type="checkbox" data-model-terms-accept${checked} />
        <span>I have reviewed and accept the applicable upstream terms, and I am permitted to download and use these model files.</span>
      </label>
    </section>`;
}

export function bindCuratedModelTerms(root: HTMLElement, onChange: () => void): void {
  bindExternalLinks(root);
  const checkbox = root.querySelector<HTMLInputElement>("[data-model-terms-accept]");
  if (!checkbox) return;
  checkbox.onchange = () => {
    setCuratedModelTermsAccepted(checkbox.checked);
    onChange();
  };
}
