import { mergeTempoCommands, parseTrack } from "./core.js";

export const PROJECT_STORAGE_KEY = "nyangnyang-mml-project-v1";

const TRACK_COLORS = ["#ef6b5a", "#e8ad45", "#5f9f8d", "#7b78b8", "#ca769b", "#5d87b6"];

export function createTrack(index, themeId = "nyang-voice") {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `track-${Date.now()}-${index}`,
    name: `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    sourceText: index === 0 ? "t120o4l4v15" : "o4l4v15",
    themeId,
    mixerVolume: 1,
    recordVelocity: 15,
    muted: false,
    solo: false,
    pianoRollVisible: true,
  };
}

export function createProject(themeId = "nyang-voice") {
  const tracks = [createTrack(0, themeId), createTrack(1, themeId), createTrack(2, themeId)];
  return {
    format: "nyangmml",
    version: 12,
    title: "",
    tracks,
    timeSignature: { numerator: 4, denominator: 4 },
    timeSignatureMap: [{ tick: 0, numerator: 4, denominator: 4 }],
    routing: { left: [tracks[0].id], right: [tracks[1].id] },
    recording: {
      mode: "append",
      startPosition: "playhead",
      editMode: "overwrite",
      pitchPriority: "high",
      quantize: "1/8",
      countIn: 1,
      metronome: false,
      metronomeVolume: 0.55,
      insertScope: "all",
      restKey: "KeyS",
      shortcuts: {
        play: "Space",
        record: "Alt+KeyR",
        stop: "Alt+KeyS",
      },
    },
    view: { selectedTrackId: tracks[0].id, loop: false, loopStart: 0, loopEnd: 0 },
  };
}

export function trackAudibilityPatch(track, control) {
  if (control === "mute") {
    const muted = !track.muted;
    return muted ? { muted: true, solo: false } : { muted: false };
  }
  const solo = !track.solo;
  return solo ? { solo: true, muted: false } : { solo: false };
}

export function trackMixStates(tracks) {
  const soloed = tracks.some((track) => track.solo);
  return tracks.map((track) => ({
    trackId: track.id,
    themeId: track.themeId,
    volume: Math.max(0, Math.min(1, Number(track.mixerVolume) || 0)),
    audible: !track.muted && (!soloed || track.solo),
  }));
}

export function sanitizeProject(value, themeId = "nyang-voice") {
  if (!value || value.format !== "nyangmml" || !Array.isArray(value.tracks) || value.tracks.length === 0) {
    return createProject(themeId);
  }
  const fallback = createProject(themeId);
  const tracks = value.tracks.map((track, index) => {
    const normalized = {
      ...createTrack(index, themeId),
      ...track,
      id: typeof track.id === "string" ? track.id : createTrack(index, themeId).id,
      name: typeof track.name === "string" ? track.name : `Track ${index + 1}`,
      sourceText: typeof track.sourceText === "string" ? track.sourceText : "",
    };
    if (normalized.muted && normalized.solo) normalized.muted = false;
    delete normalized.optimizationRestore;
    return normalized;
  });
  const tempoTrackIds = new Set(tracks.filter((track) => track.mmlRole === "tempo").map((track) => track.id));
  const migratedTempoEvents = tracks
    .filter((track) => tempoTrackIds.has(track.id))
    .flatMap((track) => {
      try { return parseTrack(track.sourceText).tempos.map(({ tick, bpm }) => ({ tick, bpm })); } catch { return []; }
    });
  if (Number(value.version) < 9 && Array.isArray(value.tempoMap)) {
    migratedTempoEvents.push(...value.tempoMap
      .map((marker) => ({
        tick: Math.max(0, Number(marker.tick) || 0),
        bpm: Math.max(1, Number(marker.bpm) || Number(value.tempo) || 120),
      })));
  }
  if (tempoTrackIds.size) {
    for (let index = tracks.length - 1; index >= 0; index -= 1) {
      if (tempoTrackIds.has(tracks[index].id)) tracks.splice(index, 1);
    }
  }
  if (migratedTempoEvents.length) {
    const preferred = tracks.find((track) => track.id === value.view?.selectedTrackId) ?? tracks[0];
    const target = [preferred, ...tracks].find((track, index, list) => track && list.indexOf(track) === index && (() => {
      try { parseTrack(track.sourceText); return true; } catch { return false; }
    })());
    if (target) target.sourceText = mergeTempoCommands(target.sourceText, migratedTempoEvents);
  }
  const ids = new Set(tracks.map((track) => track.id));
  const route = (side) => Array.isArray(value.routing?.[side]) ? value.routing[side].filter((id) => ids.has(id)) : [];
  let leftRouting = route("left");
  let rightRouting = route("right");
  const usedPreviousDefaultRouting = tracks.length >= 3
    && leftRouting.length === 2
    && leftRouting[0] === tracks[0].id
    && leftRouting[1] === tracks[1].id
    && rightRouting.length === 1
    && rightRouting[0] === tracks[2].id;
  if (Number(value.version) < 4 && usedPreviousDefaultRouting) {
    leftRouting = [tracks[0].id];
    rightRouting = [tracks[1].id];
  }
  const recording = {
    ...fallback.recording,
    ...value.recording,
    shortcuts: { ...fallback.recording.shortcuts, ...value.recording?.shortcuts },
  };
  if (Number(value.version) < 2) recording.mode = "append";
  if (Number(value.version) < 3) recording.metronome = false;
  if (Number(value.version) < 6 && recording.shortcuts.play === "Alt+KeyP") recording.shortcuts.play = "Space";
  const view = {
    ...fallback.view,
    ...value.view,
    selectedTrackId: ids.has(value.view?.selectedTrackId) ? value.view.selectedTrackId : tracks[0].id,
  };
  if (Number(value.version) < 5 && Number(view.loopStart) === 0 && Number(view.loopEnd) === 384) view.loopEnd = 0;
  const projectValue = { ...value };
  delete projectValue.tempo;
  delete projectValue.tempoMap;
  return {
    ...fallback,
    ...projectValue,
    format: "nyangmml",
    version: 12,
    tracks,
    routing: { left: leftRouting, right: rightRouting },
    recording,
    timeSignature: {
      numerator: Math.max(1, Number(value.timeSignature?.numerator) || 4),
      denominator: Math.max(1, Number(value.timeSignature?.denominator) || 4),
    },
    timeSignatureMap: Array.isArray(value.timeSignatureMap) && value.timeSignatureMap.length
      ? value.timeSignatureMap
        .map((marker) => ({
          tick: Math.max(0, Number(marker.tick) || 0),
          numerator: Math.max(1, Number(marker.numerator) || 4),
          denominator: Math.max(1, Number(marker.denominator) || 4),
        }))
        .sort((a, b) => a.tick - b.tick)
      : [{ tick: 0, numerator: Math.max(1, Number(value.timeSignature?.numerator) || 4), denominator: Math.max(1, Number(value.timeSignature?.denominator) || 4) }],
    view,
  };
}

export function projectFilename(project) {
  const title = project.title.trim().replace(/[\\/:*?"<>|]+/g, "-");
  if (title) return `${title}.nyangmml`;
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `nyangmml-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.nyangmml`;
}

export function importedMmlTitle(filename) {
  return String(filename ?? "")
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:mml|txt)$/i, "")
    .trim() ?? "";
}

export function reorderProjectTrack(project, trackId, targetId, placement = "before") {
  const tracks = project?.tracks;
  if (!Array.isArray(tracks) || trackId === targetId) return project;
  const sourceIndex = tracks.findIndex((track) => track.id === trackId);
  const targetIndex = tracks.findIndex((track) => track.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return project;

  const [track] = tracks.splice(sourceIndex, 1);
  let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  if (sourceIndex < insertIndex) insertIndex -= 1;
  tracks.splice(Math.max(0, Math.min(insertIndex, tracks.length)), 0, track);

  const order = new Map(tracks.map((item, index) => [item.id, index]));
  for (const side of ["left", "right"]) {
    if (!Array.isArray(project.routing?.[side])) continue;
    project.routing[side].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity));
  }
  return project;
}

export function applyMmlImport(project, payload, mode, themeId = "nyang-voice") {
  const draft = JSON.parse(JSON.stringify(project));
  const ranges = Array.isArray(payload?.ranges) ? payload.ranges : [];
  const trackNames = Array.isArray(payload?.trackNames) ? payload.trackNames : [];
  if (mode === "replace") {
    draft.tracks = ranges.map((sourceText, index) => ({
      ...createTrack(index, themeId),
      sourceText,
      ...(trackNames[index] ? { name: trackNames[index] } : {}),
    }));
    if (payload.replacementTitle !== undefined) draft.title = payload.replacementTitle;
    if (payload.importSource) draft.importSource = payload.importSource;
    draft.routing = {
      left: draft.tracks[0] ? [draft.tracks[0].id] : [],
      right: draft.tracks[1] ? [draft.tracks[1].id] : [],
    };
    draft.view.selectedTrackId = draft.tracks[0]?.id ?? "";
    draft.timeSignature = { numerator: 4, denominator: 4 };
    draft.timeSignatureMap = [{ tick: 0, numerator: 4, denominator: 4 }];
    draft.view.loopStart = 0;
    draft.view.loopEnd = 0;
  } else if (mode === "append") {
    ranges.forEach((sourceText, index) => {
      if (!draft.tracks[index]) draft.tracks.push(createTrack(index, themeId));
      draft.tracks[index].sourceText += sourceText;
    });
  } else if (mode === "tracks") {
    ranges.forEach((sourceText, index) => draft.tracks.push({
      ...createTrack(draft.tracks.length, themeId),
      sourceText,
      ...(trackNames[index] ? { name: trackNames[index] } : {}),
    }));
  } else if (mode === "selected") {
    const selected = draft.tracks.find((track) => track.id === draft.view.selectedTrackId);
    if (selected) selected.sourceText = ranges[0] ?? "";
  }
  return draft;
}
