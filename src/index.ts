import { dataDirectory, loadConfig } from "./config.js";
import { createServer } from "./server.js";

const root = dataDirectory();
try {
  const config = await loadConfig(root);
  const app = createServer(root, config);
  await app.listen({ host: "0.0.0.0", port: config.port });
  console.log(`llm-server: http://0.0.0.0:${config.port}/v1`);
  console.log(`Configuration: ${root}/config.json`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const timer = setTimeout(() => process.exit(1), 5000);
      timer.unref();
      void app.close().then(() => process.exit(0));
    });
  }
} catch {
  console.error(
    "Failed to start llm-server. Check config.json and whether the port is already in use.",
  );
  process.exitCode = 1;
}
