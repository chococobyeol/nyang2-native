import { encodeDuration, mergeTempoCommands, parseMmlDocument, parseTrack } from "./core.js";
import { createProject, createTrack } from "./project.js";

const TRACK_FIELDS = new Set([
  "name",
  "program",
  "songprogram",
  "panpot",
  "volume",
  "volumn",
  "visible",
  "attackdelaycorrect",
  "attacksongdelaycorrect",
  "disablenopt",
]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeSignature(value, fallback = { numerator: 4, denominator: 4 }) {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value ?? "");
  if (!match) return fallback;
  return {
    numerator: parsePositiveInteger(match[1], fallback.numerator),
    denominator: parsePositiveInteger(match[2], fallback.denominator),
  };
}

function parseTempo(value) {
  const events = String(value ?? "")
    .split(",")
    .map((item) => /^\s*(-?\d+)\s*t\s*(\d+)\s*$/i.exec(item))
    .filter(Boolean)
    .map((match) => ({ tick: Math.max(0, Number(match[1])), bpm: Math.max(1, Number(match[2])) }))
    .sort((a, b) => a.tick - b.tick);
  return { events, bpm: events.find((event) => event.tick === 0)?.bpm ?? events[0]?.bpm ?? 120 };
}

function restPrefix(ticks) {
  const duration = Math.max(0, Math.round(Number(ticks) || 0));
  return duration ? encodeDuration(duration).map((length) => `r${length}`).join("") : "";
}

function trackPartName(baseName, partIndex) {
  if (partIndex === 0) return baseName;
  return `${baseName} · ${["멜로디", "화음 1", "화음 2", "노래"][partIndex] ?? `파트 ${partIndex + 1}`}`;
}

export function parseMmiDocument(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*\[mml-score\]\s*$/im.test(text)) throw new Error("마비꼬 MMI 형식이 아닙니다.");

  const score = { version: 1, title: "", author: "", time: "4/4", tempo: "", records: [] };
  const timeSignatures = [];
  const lines = text.split("\n");
  let section = "";
  let currentRecord = null;
  let pendingMml = "";
  const nextOffsets = { startOffset: 0, startDelta: 0, startSongDelta: 0 };

  const beginRecord = (rawMml) => {
    const semicolon = rawMml.indexOf(";");
    const mml = (semicolon >= 0 ? rawMml.slice(0, semicolon + 1) : rawMml).replace(/[ \t\f\r\n]/g, "");
    currentRecord = {
      mml,
      startOffset: nextOffsets.startOffset,
      startDelta: nextOffsets.startDelta,
      startSongDelta: nextOffsets.startSongDelta,
    };
    score.records.push(currentRecord);
    nextOffsets.startDelta = 0;
    nextOffsets.startSongDelta = 0;
  };

  for (const rawLine of lines) {
    const sectionMatch = /^\s*(\[[^\]]+\])\s*$/.exec(rawLine);
    if (sectionMatch && !pendingMml) {
      section = sectionMatch[1].toLowerCase();
      currentRecord = null;
      continue;
    }

    if (pendingMml) {
      pendingMml += rawLine.trim();
      if (pendingMml.includes(";")) {
        beginRecord(pendingMml);
        pendingMml = "";
      }
      continue;
    }

    const separator = rawLine.indexOf("=");
    if (separator < 0) continue;
    const rawKey = rawLine.slice(0, separator).trim();
    const key = rawKey.toLowerCase();
    const value = rawLine.slice(separator + 1).trim();

    if (section === "[time-signature]") {
      const tick = Number.parseInt(rawKey, 10);
      if (Number.isFinite(tick) && tick >= 0) timeSignatures.push({ tick, ...parseTimeSignature(value) });
      continue;
    }
    if (section !== "[mml-score]") continue;

    if (key === "mml-track") {
      if (value.includes(";")) beginRecord(value);
      else pendingMml = value;
      continue;
    }
    if (["startoffset", "startdelta", "startsongdelta"].includes(key)) {
      const property = { startoffset: "startOffset", startdelta: "startDelta", startsongdelta: "startSongDelta" }[key];
      nextOffsets[property] = Number.parseInt(value, 10) || 0;
      continue;
    }
    if (currentRecord && TRACK_FIELDS.has(key)) {
      currentRecord[key] = value;
      continue;
    }
    if (key === "version") score.version = Number.parseInt(value, 10) || 1;
    else if (["title", "author", "time", "tempo"].includes(key)) score[key] = value;
  }

  if (pendingMml) throw new Error("끝나지 않은 mml-track 항목이 있습니다.");
  if (!score.records.length) throw new Error("불러올 mml-track 항목이 없습니다.");

  const baseTime = parseTimeSignature(score.time);
  const signatureByTick = new Map([[0, { tick: 0, ...baseTime }]]);
  timeSignatures.forEach((marker) => signatureByTick.set(marker.tick, marker));
  const tempo = parseTempo(score.tempo);
  const tracks = [];

  score.records.forEach((record, recordIndex) => {
    const parsed = parseMmlDocument(record.mml);
    const baseName = record.name?.trim() || `Track ${recordIndex + 1}`;
    parsed.tracks.forEach((part, partIndex) => {
      const sourceText = record.mml.slice(part.sourceStart, part.sourceEnd).trim();
      if (!sourceText) return;
      const offset = Math.max(0, Number(record.startOffset) + Number(partIndex === 3 ? record.startSongDelta : record.startDelta));
      tracks.push({
        name: trackPartName(baseName, partIndex),
        sourceText: `${restPrefix(offset)}${sourceText}`,
        visible: record.visible == null ? true : record.visible.toLowerCase() !== "false",
        volume: record.volume ?? record.volumn,
        mmi: {
          recordIndex,
          partIndex,
          program: Number.parseInt(record.program, 10) || 0,
          songProgram: Number.parseInt(record.songprogram, 10) || -1,
          panpot: Number.parseInt(record.panpot, 10) || 64,
        },
      });
    });
  });

  if (!tracks.length) throw new Error("불러올 MML 파트가 없습니다.");
  return {
    format: "mmi",
    version: score.version,
    title: score.title,
    author: score.author,
    tempo: tempo.bpm,
    tempoEvents: tempo.events,
    timeSignature: baseTime,
    timeSignatureMap: [...signatureByTick.values()].sort((a, b) => a.tick - b.tick),
    tracks,
  };
}

export function createProjectFromMmi(source, themeId = "nyang-voice", fallbackTitle = "") {
  const imported = parseMmiDocument(source);
  const project = createProject(themeId);
  project.title = imported.title || fallbackTitle;
  project.author = imported.author;
  project.timeSignature = imported.timeSignature;
  project.timeSignatureMap = imported.timeSignatureMap;
  project.tracks = imported.tracks.map((track, index) => ({
    ...createTrack(index, themeId),
    name: track.name,
    sourceText: track.sourceText,
    mixerVolume: track.volume == null ? 1 : Math.max(0, Math.min(1, Number(track.volume) / 100)),
    pianoRollVisible: track.visible,
    mmi: track.mmi,
  }));
  const codeTempos = new Map();
  for (const track of project.tracks) {
    for (const event of parseTrack(track.sourceText).tempos) {
      if (!codeTempos.has(event.tick)) codeTempos.set(event.tick, event.bpm);
    }
  }
  const missingTempos = (imported.tempoEvents?.length ? imported.tempoEvents : [{ tick: 0, bpm: imported.tempo }])
    .filter((event) => codeTempos.get(event.tick) !== event.bpm);
  if (missingTempos.length && project.tracks[0]) project.tracks[0].sourceText = mergeTempoCommands(project.tracks[0].sourceText, missingTempos);
  project.routing = {
    left: project.tracks[0] ? [project.tracks[0].id] : [],
    right: project.tracks[1] ? [project.tracks[1].id] : [],
  };
  project.view.selectedTrackId = project.tracks[0].id;
  project.importSource = { format: "mmi", version: imported.version };
  return project;
}
