import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { openControlPlaneDatabase } from "./storage/database.js";
import { ensureDefaultControlPlaneRoot } from "./storage/defaultControlPlaneRoot.js";

const config = loadRuntimeConfig();
const storage = openControlPlaneDatabase({
  authorizedRoot: ensureDefaultControlPlaneRoot(),
  databasePath: config.databaseRelativePath
});
const { db } = storage;
const { app, ready } = createApp(db, {
  runtimeConfig: config,
  referenceSourcesRoot: storage.referenceSourcesRoot
});
const bootstrap = await ready;
if (bootstrap.status === "partial") {
  console.warn(`Reference source bootstrap is degraded: ${bootstrap.failures.map((failure) => `${failure.connectionName} (${failure.code})`).join(", ")}`);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`Semantic Junkyard API listening on http://${config.host}:${config.port}`);
});
server.once("error", (error) => {
  console.error("Semantic Junkyard API failed to listen", error);
  if (db.open) db.close();
  process.exitCode = 1;
});

let shutdownPromise: Promise<void> | null = null;
const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = new Promise<void>((resolve) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();
    server.closeIdleConnections();
    server.close((error) => {
      clearTimeout(forceClose);
      try {
        db.close();
      } catch (closeError) {
        console.error("Failed to close Semantic Junkyard database", closeError);
        process.exitCode = 1;
      }
      if (error) {
        console.error("Failed to close Semantic Junkyard API", error);
        process.exitCode = 1;
      } else {
        console.log(`Semantic Junkyard API stopped after ${signal}`);
      }
      resolve();
    });
  });
  return shutdownPromise;
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
