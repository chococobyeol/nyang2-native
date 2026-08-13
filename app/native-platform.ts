import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";

function browserDownload(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function extensionFor(name: string) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1] ?? "";
}

export async function saveAppFile(name: string, type: string, content: BlobPart) {
  const blob = new Blob([content], { type });
  if (!isTauri()) {
    browserDownload(name, blob);
    return true;
  }

  const extension = extensionFor(name);
  const destination = await save({
    defaultPath: name,
    filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
  });
  if (!destination) return false;
  await writeFile(destination, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

export async function writeAppClipboard(text: string) {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function openExternalUrl(url: string) {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
  else window.location.href = url;
}
