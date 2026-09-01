export interface ServerStartupDependencies {
  health: () => Promise<boolean>;
  restart: () => Promise<void>;
  delay: (milliseconds: number) => Promise<void>;
}

export interface ServerStartupOptions {
  initialChecks?: number;
  restartedChecks?: number;
  intervalMs?: number;
}

export interface ServerStartupResult {
  ready: boolean;
  restarted: boolean;
  error: string | null;
}

async function waitUntilReady(
  dependencies: ServerStartupDependencies,
  checks: number,
  intervalMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < checks; attempt += 1) {
    await dependencies.delay(intervalMs);
    if (await dependencies.health()) return true;
  }
  return false;
}

/**
 * Give the shell-owned server time to bind, then reproduce the tray's clean
 * restart once if the initial launch never becomes healthy.
 */
export async function ensureServerReady(
  dependencies: ServerStartupDependencies,
  options: ServerStartupOptions = {},
): Promise<ServerStartupResult> {
  const initialChecks = options.initialChecks ?? 5;
  const restartedChecks = options.restartedChecks ?? 10;
  const intervalMs = options.intervalMs ?? 600;

  if (await dependencies.health()) {
    return { ready: true, restarted: false, error: null };
  }
  if (await waitUntilReady(dependencies, initialChecks, intervalMs)) {
    return { ready: true, restarted: false, error: null };
  }

  try {
    await dependencies.restart();
  } catch (error) {
    return {
      ready: false,
      restarted: true,
      error: (error as Error).message || String(error),
    };
  }

  const ready = await waitUntilReady(dependencies, restartedChecks, intervalMs);
  return {
    ready,
    restarted: true,
    error: ready ? null : "The model server did not become ready after restarting.",
  };
}
