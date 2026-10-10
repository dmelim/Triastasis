import type { RuntimeStatus } from "./runtime-manager";

export interface RuntimePresentation {
  description: string;
  nextStep: string;
  notice: string | null;
  downloadLabel: string | null;
  showRelease: boolean;
}

export function runtimePresentation(runtime: RuntimeStatus): RuntimePresentation {
  const target = runtime.targetVersion;
  const version = runtime.version ?? "unknown";
  const recorded = runtime.managed
    ? `Installed runtime version: ${version}.`
    : runtime.version ? `Custom runtime receipt reports version ${version}.` : "This custom runtime has no version receipt.";
  if (!runtime.installed) return { description: "No runtime is installed.", nextStep: "Complete runtime setup to generate models.", notice: null, downloadLabel: null, showRelease: true };
  if (runtime.pendingVersion && runtime.versionState !== "newer") return {
    description: `${recorded} Version ${runtime.pendingVersion} is downloaded and verified.`,
    nextStep: "Finish generation, quit Triastasis from the system tray, then reopen it to apply the update. Restart server only restarts the active runtime. Your model storage stays in place.",
    notice: `Runtime ${runtime.pendingVersion} is ready after you quit and reopen Triastasis.`,
    downloadLabel: null, showRelease: false,
  };
  if (runtime.versionState === "current") return { description: `${recorded} It matches Triastasis ${target}.`, nextStep: "No runtime update is needed.", notice: null, downloadLabel: null, showRelease: false };
  if (runtime.versionState === "newer") return { description: `${recorded} It is newer than Triastasis ${target}.`, nextStep: "Triastasis will keep this runtime. Review its compatibility through your original installation source.", notice: null, downloadLabel: null, showRelease: true };
  const description = runtime.versionState === "older"
    ? `${recorded} It is older than Triastasis ${target}.`
    : !runtime.managed && !runtime.version
      ? `This custom runtime has no version receipt, so its version could not be confirmed against Triastasis ${target}.`
      : `This runtime's version could not be confirmed against Triastasis ${target}.`;
  const notice = runtime.versionState === "older"
    ? runtime.managed ? `Runtime ${version} is older than Triastasis ${target}. Install the matching runtime in Settings > Runtime.` : `Custom runtime receipt reports version ${version}, older than Triastasis ${target}. Review Settings > Runtime.`
    : runtime.managed
      ? `Runtime version could not be confirmed. Review the matching release in Settings > Runtime.`
      : `This custom runtime has no version receipt, so Triastasis cannot confirm it matches ${target}. Review Settings > Runtime.`;
  if (runtime.updateAvailable) return {
    description,
    nextStep: `Download the runtime matching Triastasis ${target}, then quit and reopen the app to apply it. Your model storage stays in place.`,
    notice,
    downloadLabel: runtime.versionState === "older" ? `Download runtime ${target}` : `Install verified runtime ${target}`,
    showRelease: true,
  };
  const artifact = ["cuda", "cuda12", "rocm", "vulkan"].includes(runtime.backend) ? `trellis-${runtime.backend}-windows-x64.zip` : "the runtime archive for your backend";
  return {
    description,
    nextStep: runtime.managed
      ? `Open the matching release and choose a supported backend before installing runtime ${target}. Your model storage stays in place.`
      : `Open the matching release, download ${artifact}, and update this custom runtime through its original installation method. Triastasis preserves your custom binary path and model storage.`,
    notice, downloadLabel: null, showRelease: true,
  };
}

export function runtimeDownloadError(error: unknown, target: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("404")
    ? `Runtime download is not available for Triastasis ${target} yet. Open the matching release page to check availability.`
    : message;
}

export function runtimeNotice(runtime: RuntimeStatus, dismissed: string | null): string | null {
  const notice = runtimePresentation(runtime).notice;
  return notice === dismissed ? null : notice;
}
