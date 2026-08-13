import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat();
}

test("uses a local Vite bundle as the Tauri frontend", async () => {
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config.identifier, "com.chaamuchannel.nyangnyang");
  assert.equal(config.build.frontendDist, "../dist");
  assert.equal(config.bundle.iOS.minimumSystemVersion, "14.0");
  assert.equal(config.bundle.macOS.minimumSystemVersion, "11.0");

  const html = await readFile(path.join(root, "dist/index.html"), "utf8");
  assert.match(html, /<title>냥냥<\/title>/);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("does not bundle a hosted runtime, analytics beacon, or CDN font", async () => {
  const bundledFiles = (await filesBelow(path.join(root, "dist")))
    .filter((file) => /\.(?:html|css|js)$/i.test(file));
  const bundle = (await Promise.all(bundledFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(bundle, /static\.cloudflareinsights\.com|cdn\.jsdelivr\.net|nyang2\.pages\.dev/i);
  assert.doesNotMatch(bundle, /signin-with-chatgpt|_vinext/i);
});

test("bundles the same Korean UI font as the web app", async () => {
  const sourceCss = await readFile(path.join(root, "app/globals.css"), "utf8");
  assert.match(sourceCss, /font-family:\s*"OmuDaye"/);
  assert.match(sourceCss, /url\("\.\/assets\/fonts\/omyu-pretty\.woff2"\)/);

  const bundledFiles = await filesBelow(path.join(root, "dist"));
  assert.ok(bundledFiles.some((file) => /omyu-pretty-[^/]+\.woff2$/i.test(file)));
});

test("ships every hard-coded audio, theme, and help asset", async () => {
  const sources = await Promise.all([
    "app/page.tsx",
    "app/help/page.tsx",
  ].map((file) => readFile(path.join(root, file), "utf8")));
  const references = new Set(
    sources.flatMap((source) => [...source.matchAll(/["'](\/(?:assets|audio|help)\/[^"'?]+)(?:\?[^"']*)?["']/g)]
      .map((match) => match[1])),
  );
  assert.ok(references.size >= 10);
  await Promise.all([...references].map((reference) => access(path.join(root, "dist", reference))));
});

test("registers native save, clipboard, dialog, and external-link permissions", async () => {
  const capability = JSON.parse(await readFile(path.join(root, "src-tauri/capabilities/default.json"), "utf8"));
  assert.ok(capability.permissions.includes("clipboard-manager:allow-write-text"));
  assert.ok(capability.permissions.includes("dialog:default"));
  assert.ok(capability.permissions.includes("fs:allow-write-file"));
  assert.ok(capability.permissions.includes("opener:default"));

  const rust = await readFile(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  for (const plugin of ["clipboard_manager", "dialog", "fs", "opener"]) {
    assert.match(rust, new RegExp(`tauri_plugin_${plugin}`));
  }
});

test("contains generated projects for Android and Apple targets", async () => {
  await Promise.all([
    "src-tauri/gen/android/build.gradle.kts",
    "src-tauri/gen/apple/project.yml",
  ].map((file) => access(path.join(root, file))));

  const appleProject = await readFile(path.join(root, "src-tauri/gen/apple/project.yml"), "utf8");
  assert.match(appleProject, /EXECUTABLE_NAME: NyangNyang/);
  assert.match(appleProject, /TARGETED_DEVICE_FAMILY|platform: iOS/);
});
