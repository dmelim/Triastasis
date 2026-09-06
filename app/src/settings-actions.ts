export function runtimeNumbers(gpuText: string, portText: string): { gpu: number; port: number } {
  const gpu = Number(gpuText), port = Number(portText);
  if (!gpuText.trim() || !Number.isSafeInteger(gpu)) throw new Error("GPU index must be an integer");
  if (!portText.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535");
  return { gpu, port };
}
export async function saveAndRestart(save: (() => Promise<unknown>) | null, restart: () => Promise<unknown>): Promise<string> {
  if (save) await save();
  try { await restart(); }
  catch (error) { throw new Error((save ? "Settings saved; restart failed: " : "Restart failed: ") + (error instanceof Error ? error.message : String(error))); }
  return save ? "Settings saved; server restart requested" : "Server restart requested";
}
