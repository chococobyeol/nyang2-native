import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontDirectory = path.join(root, "app", "assets", "fonts");
const destination = path.join(fontDirectory, "omyu-pretty.woff2");
const temporary = `${destination}.${process.pid}.tmp`;
const source = "https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2304-01@1.0/omyu_pretty.woff2";
const expectedSha256 = "ebdd7c73ba15a83abb687a2f0b38d3b324452f102e3a00a2b34d504461d86e58";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function hasVerifiedLocalCopy() {
  try {
    return sha256(await readFile(destination)) === expectedSha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

if (!(await hasVerifiedLocalCopy())) {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to download OmuDaye font: ${response.status} ${response.statusText}`);
  }

  const font = Buffer.from(await response.arrayBuffer());
  const actualSha256 = sha256(font);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`OmuDaye font checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
  }

  await mkdir(fontDirectory, { recursive: true });
  await writeFile(temporary, font);
  await rm(destination, { force: true });
  await rename(temporary, destination);
  console.log("Prepared the bundled OmuDaye font.");
}
