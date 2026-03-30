const { spawn } = require("child_process");
const path = require("path");

const builderCli = path.join(__dirname, "..", "node_modules", "electron-builder", "cli.js");
const child = spawn(process.execPath, [builderCli, "--win"], {
  stdio: "inherit",
  windowsHide: false,
});

let shuttingDown = false;

function stopBuild(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Stopping build...`);

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "inherit",
      windowsHide: true,
    });
    killer.on("exit", () => process.exit(130));
    killer.on("error", () => process.exit(130));
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (_) {
    // Best-effort termination.
  }
  process.exit(130);
}

["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
  process.on(signal, () => stopBuild(signal));
});

child.on("error", (err) => {
  console.error("Failed to start electron-builder:", err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (shuttingDown) return;
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});
