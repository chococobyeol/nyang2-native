import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [platform, command, ...args] = process.argv.slice(2);

if (!platform || !command) {
  console.error("Usage: tauri-mobile.mjs <android|ios> <command> [...args]");
  process.exit(2);
}

const env = { ...process.env };
const localCargoHome = path.join(root, ".cargo-home");
const localRustupHome = path.join(root, ".rustup-home");
const localCargo = path.join(localCargoHome, "bin", process.platform === "win32" ? "cargo.exe" : "cargo");

if (existsSync(localCargo)) {
  env.CARGO_HOME = localCargoHome;
  env.RUSTUP_HOME = localRustupHome;
  env.PATH = `${path.join(localCargoHome, "bin")}${path.delimiter}${env.PATH ?? ""}`;
}

if (platform === "android") {
  if (!env.ANDROID_HOME && process.platform === "darwin") {
    env.ANDROID_HOME = path.join(homedir(), "Library", "Android", "sdk");
  }
  env.ANDROID_SDK_ROOT ??= env.ANDROID_HOME;

  const localNdkRoot = path.join(root, ".android-sdk", "ndk");
  if (!env.NDK_HOME && existsSync(localNdkRoot)) {
    const versions = readdirSync(localNdkRoot).sort().reverse();
    if (versions[0]) env.NDK_HOME = path.join(localNdkRoot, versions[0]);
  }

  const androidStudioJava = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if (!env.JAVA_HOME && existsSync(androidStudioJava)) env.JAVA_HOME = androidStudioJava;
}

const tauri = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const result = spawnSync(tauri, [platform, command, ...args], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

if (platform === "ios" && args.includes("aarch64-sim") && args.includes("--no-sign")) {
  const app = path.join(root, "src-tauri", "gen", "apple", "build", "arm64-sim", "냥냥.app");
  if (existsSync(app)) {
    const signed = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
    if (signed.status !== 0) process.exit(signed.status ?? 1);
  }
}
