import { unzip } from "fflate";

const SOUND_PACK_DB = "nyangnyang-user-sound-packs";
const SOUND_PACK_STORE = "packs";
const ACTIVE_PACK_ID = "active";

export type SoundPackPreset = {
  id: string;
  name: string;
  program: number;
  bankMSB: number;
  bankLSB: number;
  isDrum: boolean;
};

export type StoredSoundPack = {
  id: typeof ACTIVE_PACK_ID;
  fileName: string;
  name: string;
  importedAt: number;
  dls: ArrayBuffer;
  defText?: string;
  presets: SoundPackPreset[];
};

export function soundPackThemeId(preset: Pick<SoundPackPreset, "bankMSB" | "bankLSB" | "program" | "isDrum">) {
  return `soundpack:${preset.bankMSB}:${preset.bankLSB}:${preset.program}:${preset.isDrum ? 1 : 0}`;
}

export function parseSoundPackThemeId(value: string) {
  const match = /^soundpack:(\d+):(\d+):(\d+):([01])$/.exec(value);
  if (!match) return null;
  return {
    bankMSB: Number(match[1]),
    bankLSB: Number(match[2]),
    program: Number(match[3]),
    isDrum: match[4] === "1",
  };
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  }
}

function localizedProgramNames(defText?: string) {
  const programByName = new Map<string, number>();
  const localizedByName = new Map<string, string>();
  let section = "";
  for (const rawLine of (defText ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (section === "instrument presets") {
      const program = Number(value.split(",")[0]);
      if (Number.isFinite(program)) programByName.set(key, Math.max(0, Math.round(program) - 1));
    } else if (section === "1042") {
      localizedByName.set(key, value);
    }
  }
  return new Map(
    [...programByName].map(([name, program]) => [program, localizedByName.get(name) || name]),
  );
}

function unzipAsync(data: Uint8Array) {
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (error, files) => {
      if (error) reject(error);
      else resolve(files);
    });
  });
}

function exactArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function parseSoundPackFile(file: File): Promise<StoredSoundPack> {
  const lowerName = file.name.toLowerCase();
  let dls: ArrayBuffer;
  let defText: string | undefined;

  if (lowerName.endsWith(".dls")) {
    dls = await file.arrayBuffer();
  } else if (lowerName.endsWith(".zip")) {
    const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
    const entries = Object.entries(files).filter(([name]) => !name.endsWith("/"));
    const dlsEntry = entries.find(([name]) => name.toLowerCase().endsWith(".dls"));
    if (!dlsEntry) throw new Error("ZIP 안에서 DLS 음원 파일을 찾지 못했습니다.");
    const defEntry = entries.find(([name]) => name.toLowerCase().endsWith(".def"));
    dls = exactArrayBuffer(dlsEntry[1]);
    if (defEntry) defText = decodeText(defEntry[1]);
  } else {
    throw new Error("ZIP 또는 DLS 파일만 추가할 수 있습니다.");
  }

  let bank;
  try {
    const { SoundBankLoader } = await import("spessasynth_core");
    bank = SoundBankLoader.fromArrayBuffer(dls.slice(0));
  } catch {
    throw new Error("DLS 사운드팩을 읽지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.");
  }
  if (bank.type !== "dls") throw new Error("현재는 DLS 사운드팩만 지원합니다.");

  const localizedNames = localizedProgramNames(defText);
  const presets = bank.presets
    .filter((preset) => !/^\(not used/i.test(preset.name.trim()))
    .map((preset) => ({
      id: soundPackThemeId(preset),
      name: localizedNames.get(preset.program) || preset.name.trim() || `악기 ${preset.program + 1}`,
      program: preset.program,
      bankMSB: preset.bankMSB,
      bankLSB: preset.bankLSB,
      isDrum: preset.isDrum,
    }))
    .sort((a, b) => a.bankMSB - b.bankMSB || a.bankLSB - b.bankLSB || a.program - b.program);
  if (presets.length === 0) throw new Error("사용할 수 있는 악기가 없는 사운드팩입니다.");

  return {
    id: ACTIVE_PACK_ID,
    fileName: file.name,
    name: bank.soundBankInfo.name?.trim() || file.name.replace(/\.(zip|dls)$/i, ""),
    importedAt: Date.now(),
    dls,
    defText,
    presets,
  };
}

function openSoundPackDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SOUND_PACK_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SOUND_PACK_STORE)) {
        request.result.createObjectStore(SOUND_PACK_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openSoundPackDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(SOUND_PACK_STORE, mode);
      const request = run(transaction.objectStore(SOUND_PACK_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function loadStoredSoundPack() {
  return withStore<StoredSoundPack | undefined>("readonly", (store) => store.get(ACTIVE_PACK_ID));
}

export function saveStoredSoundPack(pack: StoredSoundPack) {
  return withStore<IDBValidKey>("readwrite", (store) => store.put(pack));
}

export function deleteStoredSoundPack() {
  return withStore<undefined>("readwrite", (store) => store.delete(ACTIVE_PACK_ID) as IDBRequest<undefined>);
}
