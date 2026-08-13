"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, ClipboardCopy, Ellipsis, FileMusic, Maximize2, Minimize2, MousePointer2, MoveHorizontal, MoveVertical, Music2, Pause, Play, Plus, Redo2, Repeat2, Settings, SkipBack, SkipForward, Square, Undo2, Upload, X } from "lucide-react";
import {
  combineTracks,
  deleteTempoCommand,
  encodeDuration,
  mergeTempoCommands,
  MmlSyntaxError,
  mergeTempoEvents,
  parseMmlDocument,
  parseTrack,
  serializeTrackEvents,
  sourceRangeAtTick,
  tempoAtTick,
  tickToSeconds,
  TICKS_PER_QUARTER,
  transposeMmlText,
  transposeMmlTextRangeWithSelection,
  upsertTempoCommand,
} from "../mml/core.js";
import { applyMmlImport, createProject, createTrack, importedMmlTitle, PROJECT_STORAGE_KEY, projectFilename, reorderProjectTrack, sanitizeProject, trackAudibilityPatch, trackMixStates } from "../mml/project.js";
import { appendLegatoContinuation, armedInputStartAt, countInBeats, elapsedSecondsToTicks, liveInputTicks, liveNotesEndTick, quantizationGridTicks, quantizedInputsEndTick, quantizeInputs, recordingInputEndAt, recordingStartPlan, recordingToTrackTexts, resolveRecordingStartTick, snapTickToGrid, syncedPlaybackStartAt } from "../mml/recording.js";
import { loadAutosave, saveAutosave } from "../mml/storage.js";
import { adjacentMeasureTick, anchoredScrollOffset, buildMetronomeEvents, buildTimelineGrid, clampTimelineZoom, followTimelineScroll, normalizedWheelSteps, zoomPreviewPositionOffset, zoomPreviewTransform } from "../mml/timeline.js";
import { MML_NOTE_LENGTHS, setSelectedMmlLength, shiftSelectedMmlLength } from "../mml/editing.js";
import { expandMmlText, optimizeMmlText } from "../mml/optimization.js";
import { createProjectFromMmi } from "../mml/mmi.js";
import { createMidiFile, createProjectFromMidi, midiFilename } from "../mml/midi.js";
import { decodeThreeMleFile, isThreeMleDocument, parseThreeMleDocument } from "../mml/three-mle.js";
import { useI18n } from "../i18n";
import { saveAppFile, writeAppClipboard } from "../native-platform";
import RangeControl from "./range-control";

type KeyboardSide = "left" | "right";

type ThemeOption = {
  id: string;
  name: string;
  accent: string;
};

export type MmlInputSink = {
  noteOn: (inputId: string, side: KeyboardSide, midi: number, at: number) => void;
  noteOff: (inputId: string, at: number) => void;
  restOn: (at: number) => void;
  restOff: (at: number) => void;
};

type Props = {
  currentThemeId: string;
  themes: ThemeOption[];
  visible: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  registerInputSink: (sink: MmlInputSink | null) => void;
  prepareThemes: (themeIds: string[]) => Promise<void>;
  playMidi: (sourceId: string, midi: number, themeId: string, volume: number, trackId: string, delaySeconds?: number) => void;
  releaseMidi: (sourceId: string) => void;
  stopMmlAudio: () => void;
  syncTrackMix: (states: Array<{ trackId: string; themeId: string; volume: number; audible: boolean }>) => void;
  clickMetronome: (accent: boolean, volume: number, delaySeconds?: number, preparing?: boolean) => () => void;
  onPlayShortcutChange?: (shortcut: string) => void;
  onRestShortcutChange?: (shortcut: string) => void;
  onRestPressedChange?: (pressed: boolean) => void;
};

type RecordingInput = {
  id: string;
  inputId: string;
  side: KeyboardSide;
  midi: number;
  startedAt: number;
  endedAt: number;
  velocityByTrack: Record<string, number>;
};

type LiveRecordingNote = {
  id: string;
  midi: number;
  tick: number;
  duration: number;
  color: string;
};

type MmlImportPayload = {
  ranges: string[];
  replacementTitle?: string;
  trackNames?: string[];
  importSource?: { format: string };
};

const PIANO_PITCH_ROW_HEIGHT = 12;

type ParsedTrack = ReturnType<typeof parseTrack>;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const PIANO_PIXELS_PER_TICK = 190 / (TICKS_PER_QUARTER * 4);

function saveBlob(name: string, type: string, content: BlobPart) {
  void saveAppFile(name, type, content).catch((error) => {
    window.alert(`파일을 저장하지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`);
  });
}

function secondsToTick(seconds: number, tempoEvents: Array<{ tick: number; bpm: number }>, maxTick: number) {
  let low = 0;
  let high = Math.max(maxTick, TICKS_PER_QUARTER * 16);
  while (tickToSeconds(high, tempoEvents) < seconds) high *= 2;
  for (let index = 0; index < 30; index += 1) {
    const middle = (low + high) / 2;
    if (tickToSeconds(middle, tempoEvents) < seconds) low = middle;
    else high = middle;
  }
  return Math.round((low + high) / 2);
}

function formatPlaybackTime(seconds: number) {
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const totalSeconds = Math.floor(totalTenths / 10);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const tenths = totalTenths % 10;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}.${tenths}`
    : `${minutes}:${String(remainder).padStart(2, "0")}.${tenths}`;
}

function renderRecordingProject(
  baseProject: any,
  inputs: RecordingInput[],
  rests: Array<{ start: number; end: number }>,
  options: { bpm: number; quantizeBpm?: number; origin: number; startTick: number; sessionEndedAt?: number },
) {
  const draft = clone(baseProject);
  const quantizeBpm = options.quantizeBpm ?? options.bpm;
  const result = recordingToTrackTexts(inputs, baseProject.tracks, baseProject.routing, {
    bpm: quantizeBpm,
    quantize: baseProject.recording.quantize,
    pitchPriority: baseProject.recording.pitchPriority,
    origin: options.origin,
  });
  let recordedEndTick = result.endTick;
  for (const rest of rests) {
    const quantizedRest = quantizeInputs([{
      id: "rest-end",
      side: "left",
      midi: 60,
      startedAt: 0,
      endedAt: rest.end,
    }], quantizeBpm, baseProject.recording.quantize, 0)[0];
    recordedEndTick = Math.max(recordedEndTick, quantizedRest.duration);
  }
  if (baseProject.recording.mode === "realtime" && options.sessionEndedAt !== undefined) {
    const session = quantizeInputs([{
      id: "session-end",
      side: "left",
      midi: 60,
      startedAt: options.origin,
      endedAt: Math.max(options.origin, options.sessionEndedAt),
    }], quantizeBpm, baseProject.recording.quantize, options.origin)[0];
    recordedEndTick = Math.max(recordedEndTick, session.duration);
  }

  const recordingLength = Math.max(0, recordedEndTick);
  const connectedIds = new Set([...baseProject.routing.left, ...baseProject.routing.right]);
  draft.tracks.forEach((track: any, index: number) => {
    if (track.mmlRole === "tempo") return;
    const newText = result.texts.get(track.id);
    const fillsTimeline = recordingLength > 0
      && connectedIds.has(track.id)
      && (baseProject.recording.mode === "realtime" || rests.length > 0);
    const isUsed = result.usedTrackIds.has(track.id) || fillsTimeline;
    if (!isUsed && !(baseProject.recording.editMode === "insert" && baseProject.recording.insertScope === "all")) return;
    let existing;
    try { existing = parseTrack(track.sourceText); } catch { existing = { notes: [], tempos: [] }; }
    const inserted = newText
      ? parseTrack(newText).notes.map((note: any) => ({
        tick: note.tick + options.startTick,
        duration: note.duration,
        midi: note.midi,
        velocity: note.velocity,
      }))
      : [];
    let notes = existing.notes.map((note: any) => ({
      tick: note.tick,
      duration: note.duration,
      midi: note.midi,
      velocity: note.velocity,
    }));
    if (baseProject.recording.editMode === "insert") {
      notes = notes.map((note: any) => note.tick >= options.startTick ? { ...note, tick: note.tick + recordingLength } : note);
      if (isUsed) notes.push(...inserted);
    } else if (isUsed) {
      notes = notes.filter((note: any) => note.tick + note.duration <= options.startTick || note.tick >= options.startTick + recordingLength);
      notes.push(...inserted);
    }
    const initialVelocity = [...notes].sort((a: any, b: any) => a.tick - b.tick)[0]?.velocity
      ?? track.recordVelocity
      ?? 15;
    let sourceText = serializeTrackEvents(notes, {
      velocity: initialVelocity,
    });
    sourceText = mergeTempoCommands(sourceText, existing.tempos ?? []);
    const parsedDuration = parseTrack(sourceText).duration;
    if (isUsed && recordedEndTick > 0 && parsedDuration < options.startTick + recordedEndTick) {
      sourceText += encodeDuration(options.startTick + recordedEndTick - parsedDuration).map((length: string) => `r${length}`).join("");
    }
    draft.tracks[index].sourceText = sourceText;
  });
  return { project: draft, result, recordedEndTick };
}

function noteLabel(midi: number) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function shortcutLabel(value: string) {
  return value.replace(/Key|Digit/g, "").replace(/\+/g, " ");
}

function ticksToRecordingSeconds(ticks: number, bpm: number) {
  return ticks / (TICKS_PER_QUARTER * bpm / 60);
}

function shortcutFromEvent(event: ReactKeyboardEvent<HTMLInputElement> | KeyboardEvent) {
  const modifiers = [event.ctrlKey || event.metaKey ? "Mod" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...modifiers, event.code].join("+");
}

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.split("+");
  return event.code === parts.at(-1)
    && event.altKey === parts.includes("Alt")
    && event.shiftKey === parts.includes("Shift")
    && (event.ctrlKey || event.metaKey) === parts.includes("Mod");
}

export default function MmlStudio({
  currentThemeId,
  themes,
  visible,
  expanded,
  onExpandedChange,
  onClose,
  registerInputSink,
  prepareThemes,
  playMidi,
  releaseMidi,
  stopMmlAudio,
  syncTrackMix,
  clickMetronome,
  onPlayShortcutChange,
  onRestShortcutChange,
  onRestPressedChange,
}: Props) {
  const { brandName, t } = useI18n();
  const [project, setProject] = useState(() => createProject(currentThemeId));
  const [hydrated, setHydrated] = useState(false);
  const [past, setPast] = useState<any[]>([]);
  const [future, setFuture] = useState<any[]>([]);
  const [parseError, setParseError] = useState<{ message: string; trackIndex: number; index: number; line: number; column: number } | null>(null);
  const [parsedTracks, setParsedTracks] = useState<ParsedTrack[]>([]);
  const [lastValidTracks, setLastValidTracks] = useState<ParsedTrack[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [pitchZoom, setPitchZoom] = useState(1);
  const [pianoViewportWidth, setPianoViewportWidth] = useState(0);
  const [pianoViewportHeight, setPianoViewportHeight] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recordState, setRecordState] = useState<"idle" | "count-in" | "recording">("idle");
  const [recordingMessage, setRecordingMessage] = useState("");
  const [restInputActive, setRestInputActive] = useState(false);
  const [metronomeVisual, setMetronomeVisual] = useState({ beat: -1, count: 4, preparing: false, pulse: 0 });
  const [liveRecordingNotes, setLiveRecordingNotes] = useState<LiveRecordingNote[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);
  const [settingsView, setSettingsView] = useState(false);
  const [trackSettingsView, setTrackSettingsView] = useState(false);
  const [trackSettingsAnchor, setTrackSettingsAnchor] = useState<{ x: number; y: number } | null>(null);
  const [batchTrackIds, setBatchTrackIds] = useState<string[]>([]);
  const [batchSettingsView, setBatchSettingsView] = useState(false);
  const [batchSettingsAnchor, setBatchSettingsAnchor] = useState<{ x: number; y: number } | null>(null);
  const [fileMenuView, setFileMenuView] = useState(false);
  const [importPayload, setImportPayload] = useState<MmlImportPayload | null>(null);
  const [durationMenu, setDurationMenu] = useState<{ x: number; y: number; trackId: string; start: number; end: number } | null>(null);
  const [timelineEditor, setTimelineEditor] = useState<{ tick: number; bpm: number; numerator: number; denominator: number; tempoTrackId: string; x?: number; y?: number } | null>(null);
  const [trackReorder, setTrackReorder] = useState<{ trackId: string; targetId: string | null; placement: "before" | "after" } | null>(null);
  const [mobileTrackListCollapsed, setMobileTrackListCollapsed] = useState(false);
  const [noteSelectMode, setNoteSelectMode] = useState(false);
  const [sourceSelection, setSourceSelection] = useState<{ trackId: string; start: number; end: number } | null>(null);
  const [noteMarquee, setNoteMarquee] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const trackReorderRef = useRef<{
    pointerId: number;
    trackId: string;
    targetId: string | null;
    placement: "before" | "after";
    list: HTMLElement;
    handle: HTMLButtonElement;
    cleanup: () => void;
  } | null>(null);
  const trackDragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    axis: "x" | "y" | null;
    scrollLeft: number;
    targetScrollLeft: number;
    frame: number;
    dragging: boolean;
  } | null>(null);
  const suppressTrackClickRef = useRef(false);
  const pianoRollRef = useRef<HTMLDivElement | null>(null);
  const pianoSelectionRef = useRef<{ pointerId: number; pointerType: string; startX: number; startY: number; endX: number; endY: number; moved: boolean } | null>(null);
  const pianoTouchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pianoTouchPanRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const suppressPianoClickRef = useRef(false);
  const timelineEditorRef = useRef<HTMLDivElement | null>(null);
  const trackSettingsRef = useRef<HTMLDivElement | null>(null);
  const batchSettingsRef = useRef<HTMLDivElement | null>(null);
  const pianoRollCenteredRef = useRef(false);
  const pianoCanvasRef = useRef<HTMLDivElement | null>(null);
  const pianoGridRef = useRef<HTMLDivElement | null>(null);
  const pianoRulerRef = useRef<HTMLDivElement | null>(null);
  const pianoPitchLabelsRef = useRef<HTMLDivElement | null>(null);
  const timelineZoomRef = useRef(1);
  const pitchZoomRef = useRef(1);

  const clearSourceSelection = useCallback((collapseEditor = true) => {
    setSourceSelection(null);
    setNoteMarquee(null);
    if (!collapseEditor) return;
    const editor = editorRef.current;
    if (editor && editor.selectionStart !== editor.selectionEnd) {
      editor.setSelectionRange(editor.selectionEnd, editor.selectionEnd);
    }
  }, []);
  const timelineZoomAnchorRef = useRef<{ tick: number; offset: number } | null>(null);
  const pitchZoomAnchorRef = useRef<{ midi: number; offset: number } | null>(null);
  const wheelZoomRef = useRef<{
    frame: number;
    commitTimer: number | null;
    timelineSteps: number;
    pitchSteps: number;
    timelineBaseZoom: number;
    pitchBaseZoom: number;
    timelineTargetZoom: number;
    pitchTargetZoom: number;
    timelineAnchor: { tick: number; offset: number } | null;
    pitchAnchor: { midi: number; offset: number } | null;
    activeUntil: number;
  }>({
    frame: 0,
    commitTimer: null,
    timelineSteps: 0,
    pitchSteps: 0,
    timelineBaseZoom: 1,
    pitchBaseZoom: 1,
    timelineTargetZoom: 1,
    pitchTargetZoom: 1,
    timelineAnchor: null,
    pitchAnchor: null,
    activeUntil: 0,
  });
  const pianoRollWheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef(project);
  const playTimersRef = useRef<number[]>([]);
  const playRafRef = useRef(0);
  const playSchedulerRef = useRef<number | null>(null);
  const startPlaybackRef = useRef<(fromTick?: number) => void>(() => undefined);
  const playbackGenerationRef = useRef(0);
  const resumeAfterThemeChangeRef = useRef<number | null>(null);
  const playStartedRef = useRef({ audioStartedAt: 0, tick: 0 });
  const countInTimerRef = useRef<number | null>(null);
  const countInClickTimersRef = useRef(new Set<number>());
  const beatVisualTimersRef = useRef(new Set<number>());
  const metronomeTimerRef = useRef<number | null>(null);
  const metronomeClockRef = useRef<{ startAt: number; beatSeconds: number } | null>(null);
  const standaloneMetronomeCancelsRef = useRef(new Set<() => void>());
  const playbackMetronomeCancelsRef = useRef(new Set<() => void>());
  const stopMetronomeClockRef = useRef<() => void>(() => undefined);
  const scheduleBeatVisualRef = useRef<(beat: number, count: number, preparing: boolean, delaySeconds?: number) => void>(() => undefined);
  const clearBeatVisualTimersRef = useRef<() => void>(() => undefined);
  const recordingStartRef = useRef(0);
  const recordingStartTickRef = useRef(0);
  const recordingTempoRef = useRef(120);
  const recordingDefaultTempoRef = useRef(120);
  const recordingTempoEventsRef = useRef<Array<{ tick: number; bpm: number }>>([]);
  const recordingBaseProjectRef = useRef<any | null>(null);
  const recordingArmedRef = useRef(false);
  const recordingActiveRef = useRef(false);
  const recordingRafRef = useRef(0);
  const playheadRef = useRef(0);
  const recordingInputsRef = useRef<RecordingInput[]>([]);
  const activeRecordingRef = useRef(new Map<string, Omit<RecordingInput, "endedAt">>());
  const appendCursorRef = useRef(0);
  const appendWallStartRef = useRef<number | null>(null);
  const explicitRestsRef = useRef<Array<{ start: number; end: number }>>([]);
  const restStartedRef = useRef<number | null>(null);

  const selectedTrack = project.tracks.find((track: any) => track.id === project.view.selectedTrackId) ?? project.tracks[0];
  const syncSourceSelectionFromEditor = useCallback((editor: HTMLTextAreaElement) => {
    setSourceSelection(editor.selectionStart === editor.selectionEnd
      ? null
      : { trackId: selectedTrack.id, start: editor.selectionStart, end: editor.selectionEnd });
  }, [selectedTrack.id]);

  useEffect(() => {
    if (!visible) return;
    const syncActiveEditorSelection = () => {
      const editor = editorRef.current;
      if (editor && document.activeElement === editor) syncSourceSelectionFromEditor(editor);
    };
    document.addEventListener("selectionchange", syncActiveEditorSelection);
    return () => document.removeEventListener("selectionchange", syncActiveEditorSelection);
  }, [syncSourceSelectionFromEditor, visible]);
  const batchSelectedTracks = useMemo(
    () => project.tracks.filter((track: any) => batchTrackIds.includes(track.id)),
    [batchTrackIds, project.tracks],
  );
  const batchThemeId = batchSelectedTracks.length > 0
    && batchSelectedTracks.every((track: any) => track.themeId === batchSelectedTracks[0].themeId)
    ? batchSelectedTracks[0].themeId
    : "";
  const batchRecordVelocity = batchSelectedTracks.length > 0
    && batchSelectedTracks.every((track: any) => track.recordVelocity === batchSelectedTracks[0].recordVelocity)
    ? String(batchSelectedTracks[0].recordVelocity)
    : "";
  const batchMixerVolume = batchSelectedTracks[0]?.mixerVolume ?? 1;

  useEffect(() => () => {
    trackReorderRef.current?.cleanup();
    trackReorderRef.current = null;
    document.documentElement.classList.remove("is-track-reordering");
  }, []);
  const recordingShortcuts = Object.assign({
    play: "Space",
    record: "Alt+KeyR",
    stop: "Alt+KeyS",
  }, project.recording.shortcuts ?? {});

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    syncTrackMix(trackMixStates(project.tracks));
  }, [project.tracks, syncTrackMix]);

  useEffect(() => {
    setBatchTrackIds((current) => {
      const existing = current.filter((id) => project.tracks.some((track: any) => track.id === id));
      return existing.length === current.length ? current : existing;
    });
  }, [project.tracks]);

  useEffect(() => {
    if (batchSelectedTracks.length === 0) {
      setBatchSettingsView(false);
      setBatchSettingsAnchor(null);
    }
  }, [batchSelectedTracks.length]);

  useEffect(() => {
    onRestShortcutChange?.(project.recording.restKey);
  }, [onRestShortcutChange, project.recording.restKey]);

  useEffect(() => {
    onPlayShortcutChange?.(recordingShortcuts.play);
  }, [onPlayShortcutChange, recordingShortcuts.play]);

  useEffect(() => {
    onRestPressedChange?.(restInputActive);
    return () => onRestPressedChange?.(false);
  }, [onRestPressedChange, restInputActive]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const appendTimelineSecondsAt = useCallback((wallAt: number) => {
    const cursorTick = appendCursorRef.current * TICKS_PER_QUARTER;
    const wallStart = appendWallStartRef.current;
    if (wallStart === null) return appendCursorRef.current;
    const absoluteStartTick = recordingStartTickRef.current + cursorTick;
    const elapsedTicks = elapsedSecondsToTicks(
      absoluteStartTick,
      Math.max(0, wallAt - wallStart),
      recordingTempoEventsRef.current,
      recordingDefaultTempoRef.current,
    );
    return (cursorTick + elapsedTicks) / TICKS_PER_QUARTER;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await loadAutosave();
        if (cancelled) return;
        if (saved?.project) {
          setProject(sanitizeProject(saved.project, currentThemeId));
          setPast(Array.isArray(saved.past) ? saved.past.slice(-100) : []);
          setFuture(Array.isArray(saved.future) ? saved.future.slice(0, 100) : []);
        } else {
          const legacy = window.localStorage.getItem(PROJECT_STORAGE_KEY);
          if (legacy) setProject(sanitizeProject(JSON.parse(legacy), currentThemeId));
        }
      } catch {
        const legacy = window.localStorage.getItem(PROJECT_STORAGE_KEY);
        if (legacy && !cancelled) setProject(sanitizeProject(JSON.parse(legacy), currentThemeId));
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [currentThemeId]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveAutosave({ project, past, future, savedAt: Date.now() }).catch(() => {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [future, hydrated, past, project]);

  const commit = useCallback((updater: any) => {
    setProject((current: any) => {
      const next = typeof updater === "function" ? updater(clone(current)) : updater;
      setPast((items) => [...items.slice(-99), clone(current)]);
      setFuture([]);
      return next;
    });
  }, []);

  const applyDurationResult = useCallback((trackId: string, result: { source: string; selectionStart: number; selectionEnd: number; changed: number }) => {
    if (!result.changed) {
      setRecordingMessage(t("선택 영역에 길이를 바꿀 음표나 쉼표가 없습니다."));
      setDurationMenu(null);
      return false;
    }
    commit((draft: any) => {
      const track = draft.tracks.find((item: any) => item.id === trackId);
      if (track) track.sourceText = result.source;
      return draft;
    });
    setDurationMenu(null);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
    return true;
  }, [commit, t]);

  const setSelectionDuration = useCallback((denominator: number, dots: number) => {
    if (!durationMenu) return;
    const track = projectRef.current.tracks.find((item: any) => item.id === durationMenu.trackId);
    if (!track) return;
    applyDurationResult(track.id, setSelectedMmlLength(track.sourceText, durationMenu.start, durationMenu.end, denominator, dots));
  }, [applyDurationResult, durationMenu]);

  const transposeSelection = useCallback((delta: number) => {
    if (!durationMenu || !delta || recordState !== "idle") return;
    const track = projectRef.current.tracks.find((item: any) => item.id === durationMenu.trackId);
    if (!track) return;
    try {
      const result = transposeMmlTextRangeWithSelection(track.sourceText, delta, durationMenu.start, durationMenu.end);
      commit((draft: any) => {
        const target = draft.tracks.find((item: any) => item.id === track.id);
        if (target) target.sourceText = result.source;
        return draft;
      });
      setSourceSelection({ trackId: track.id, start: result.selectionStart, end: result.selectionEnd });
      setDurationMenu(null);
      setRecordingMessage(t("선택한 음을 {delta}반음 이조했습니다.", { delta: `${delta > 0 ? "+" : ""}${delta}` }));
      window.requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(result.selectionStart, result.selectionEnd);
        setSourceSelection({ trackId: track.id, start: result.selectionStart, end: result.selectionEnd });
      });
    } catch (error) {
      setRecordingMessage(t((error as Error).message || "선택한 음을 이조하지 못했습니다."));
    }
  }, [commit, durationMenu, recordState, t]);

  const shiftEditorSelectionDuration = useCallback((direction: number) => {
    const editor = editorRef.current;
    if (!editor || editor.selectionStart === editor.selectionEnd) return false;
    const trackId = projectRef.current.view.selectedTrackId;
    const track = projectRef.current.tracks.find((item: any) => item.id === trackId);
    if (!track) return false;
    return applyDurationResult(track.id, shiftSelectedMmlLength(track.sourceText, editor.selectionStart, editor.selectionEnd, direction));
  }, [applyDurationResult]);

  useEffect(() => {
    if (!durationMenu) return;
    const close = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".mml-duration-menu")) return;
      setDurationMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [durationMenu]);

  const undo = useCallback(() => {
    setPast((items) => {
      if (!items.length) return items;
      const previous = items.at(-1);
      setFuture((values) => [clone(projectRef.current), ...values].slice(0, 100));
      setProject(previous);
      return items.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[0];
      setPast((values) => [...values, clone(projectRef.current)].slice(-100));
      setProject(next);
      return items.slice(1);
    });
  }, []);

  useEffect(() => {
    try {
      const combined = combineTracks(project.tracks.map((track: any) => track.sourceText));
      const parsed = parseMmlDocument(combined).tracks.map((track: any) => {
        return {
          ...track,
          notes: track.notes.map((note: any) => ({
            ...note,
            sourceStart: note.sourceStart - track.sourceStart,
            sourceEnd: note.sourceEnd - track.sourceStart,
          })),
        };
      });
      setParsedTracks(parsed);
      setLastValidTracks(parsed);
      setParseError(null);
    } catch (error) {
      const syntax = error as InstanceType<typeof MmlSyntaxError> & { trackIndex?: number };
      const trackIndex = syntax.trackIndex ?? 0;
      const trackOffset = 4 + project.tracks.slice(0, trackIndex).reduce((sum: number, track: any) => sum + track.sourceText.length + 1, 0);
      const localIndex = Math.max(0, syntax.index - trackOffset);
      const before = project.tracks[trackIndex]?.sourceText.slice(0, localIndex) ?? "";
      const lines = before.split("\n");
      setParseError({
        message: t(syntax.message || "MML을 해석하지 못했습니다."),
        trackIndex,
        index: localIndex,
        line: lines.length,
        column: (lines.at(-1)?.length ?? 0) + 1,
      });
      setParsedTracks([]);
    }
  }, [project.tracks, t]);

  const displayTracks = parsedTracks.length ? parsedTracks : lastValidTracks;
  const selectedTrackIndex = project.tracks.findIndex((track: any) => track.id === selectedTrack.id);
  const playbackSourceRange = useMemo(
    () => playing ? sourceRangeAtTick(displayTracks[selectedTrackIndex], playhead) : null,
    [displayTracks, playhead, playing, selectedTrackIndex],
  );

  const trackTempoEvents = useMemo(
    () => displayTracks.flatMap((track: any, trackIndex: number) => track.tempos.map((event: any) => ({ ...event, trackIndex }))).sort((a: any, b: any) => a.tick - b.tick),
    [displayTracks],
  );

  const allTempoEvents = useMemo(
    () => mergeTempoEvents(trackTempoEvents, [], 120),
    [trackTempoEvents],
  );
  const baseTempo = tempoAtTick(0, allTempoEvents, 120);

  const tempoConflict = useMemo(() => {
    const byTick = new Map<number, Set<number>>();
    for (const event of trackTempoEvents) {
      const values = byTick.get(event.tick) ?? new Set();
      values.add(event.bpm);
      byTick.set(event.tick, values);
    }
    const conflict = [...byTick.entries()].find(([, values]) => values.size > 1);
    return conflict ? t("{tick} tick의 템포가 트랙마다 다릅니다. 위쪽 트랙의 템포를 사용합니다.", { tick: Math.round(conflict[0]) }) : "";
  }, [t, trackTempoEvents]);

  const recordTempo = tempoAtTick(playhead, allTempoEvents, 120);
  const recordMeter = [...project.timeSignatureMap]
    .filter((marker: any) => marker.tick <= playhead)
    .sort((a: any, b: any) => a.tick - b.tick)
    .at(-1) ?? { tick: 0, ...project.timeSignature };

  const songDuration = useMemo(
    () => Math.max(TICKS_PER_QUARTER * 4, ...displayTracks.map((track: any) => track.duration)),
    [displayTracks],
  );
  const currentPlaybackSeconds = tickToSeconds(
    Math.max(0, Math.min(playhead, songDuration)),
    allTempoEvents,
    baseTempo,
  );
  const totalPlaybackSeconds = tickToSeconds(songDuration, allTempoEvents, baseTempo);
  const selectedTrackCharacterCount = selectedTrack.sourceText.length;

  const clearPlayback = useCallback(() => {
    playbackGenerationRef.current += 1;
    playTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    playTimersRef.current = [];
    if (playSchedulerRef.current !== null) window.clearInterval(playSchedulerRef.current);
    playSchedulerRef.current = null;
    playbackMetronomeCancelsRef.current.forEach((cancel) => cancel());
    playbackMetronomeCancelsRef.current.clear();
    clearBeatVisualTimersRef.current();
    window.cancelAnimationFrame(playRafRef.current);
    stopMmlAudio();
    setPlaying(false);
  }, [stopMmlAudio]);

  const schedulePlayback = useCallback((fromTick = playhead) => {
    if (parseError || !displayTracks.length) return;
    const runningMetronomeClock = metronomeClockRef.current;
    const replayFromTick = fromTick >= songDuration ? 0 : fromTick;
    const requestedStartTick = Math.max(0, Math.min(replayFromTick, songDuration));
    const loopStartTick = Math.max(0, Math.min(project.view.loopStart, songDuration));
    const loopEndTick = project.view.loopEnd > loopStartTick ? Math.min(project.view.loopEnd, songDuration) : songDuration;
    const startTick = project.view.loop && (requestedStartTick < loopStartTick || requestedStartTick >= loopEndTick)
      ? loopStartTick
      : requestedStartTick;
    const startSeconds = tickToSeconds(startTick, allTempoEvents, baseTempo);
    const endTick = project.view.loop ? Math.max(loopEndTick, startTick + 1) : songDuration;
    const endSeconds = tickToSeconds(endTick, allTempoEvents, baseTempo);
    const now = performance.now() / 1000;
    const currentMeter = [...project.timeSignatureMap]
      .filter((marker: any) => marker.tick <= startTick)
      .sort((a: any, b: any) => a.tick - b.tick)
      .at(-1) ?? { tick: 0, ...project.timeSignature };
    const audioStartedAt = syncedPlaybackStartAt(project.recording.metronome, runningMetronomeClock, now, {
      startTick,
      meterStartTick: currentMeter.tick,
      timeSignature: currentMeter,
    });
    if (project.recording.metronome) stopMetronomeClockRef.current();
    const playbackWait = Math.max(0, audioStartedAt - now);
    playStartedRef.current = { audioStartedAt, tick: startTick };
    setPlaying(true);

    const scheduledNotes: Array<{ note: any; track: any; noteStart: number; noteEnd: number; sourceId: string }> = [];
    project.tracks.forEach((track: any, trackIndex: number) => {
      for (const note of displayTracks[trackIndex]?.notes ?? []) {
        if (note.tick + note.duration <= startTick || note.tick >= endTick) continue;
        const noteStart = Math.max(note.tick, startTick);
        const noteEnd = Math.min(note.tick + note.duration, endTick);
        const sourceId = `mml:${track.id}:${note.sourceStart}:${now}`;
        scheduledNotes.push({ note, track, noteStart, noteEnd, sourceId });
      }
    });
    scheduledNotes.sort((a, b) => a.noteStart - b.noteStart);
    const scheduledBeats = buildMetronomeEvents(endTick, project.timeSignatureMap, project.timeSignature)
      .filter((beat: any) => beat.tick >= startTick && beat.tick < endTick);
    let scheduleCursor = 0;
    let beatCursor = 0;
    const scheduleWindow = () => {
      const elapsed = performance.now() / 1000 - playStartedRef.current.audioStartedAt;
      while (scheduleCursor < scheduledNotes.length) {
        const item = scheduledNotes[scheduleCursor];
        const startsIn = tickToSeconds(item.noteStart, allTempoEvents, baseTempo) - startSeconds - elapsed;
        if (startsIn > 0.35) break;
        const duration = Math.max(0.01, tickToSeconds(item.noteEnd, allTempoEvents, baseTempo) - tickToSeconds(item.noteStart, allTempoEvents, baseTempo));
        const delaySeconds = Math.max(0, startsIn);
        const volume = item.note.velocity / 15;
        if (item.track.themeId.startsWith("soundpack:") && delaySeconds > 0) {
          // SpessaSynth queues future MIDI events inside its AudioWorklet and does
          // not expose a way to remove them. Keep the start timer on the main
          // thread so pause/stop can cancel it before the note reaches the worklet.
          playTimersRef.current.push(window.setTimeout(() => {
            playMidi(item.sourceId, item.note.midi, item.track.themeId, volume, item.track.id, 0);
            playTimersRef.current.push(window.setTimeout(() => releaseMidi(item.sourceId), duration * 1000));
          }, delaySeconds * 1000));
        } else {
          playMidi(item.sourceId, item.note.midi, item.track.themeId, volume, item.track.id, delaySeconds);
          playTimersRef.current.push(window.setTimeout(() => releaseMidi(item.sourceId), (delaySeconds + duration) * 1000));
        }
        scheduleCursor += 1;
      }
      while (beatCursor < scheduledBeats.length) {
        const beat = scheduledBeats[beatCursor];
        const startsIn = tickToSeconds(beat.tick, allTempoEvents, baseTempo) - startSeconds - elapsed;
        if (startsIn > 0.35) break;
        if (startsIn < -0.04) {
          beatCursor += 1;
          continue;
        }
        if (!projectRef.current.recording.metronome) break;
        const delaySeconds = Math.max(0, startsIn);
        const cancel = clickMetronome(beat.accent, projectRef.current.recording.metronomeVolume, delaySeconds, false);
        playbackMetronomeCancelsRef.current.add(cancel);
        scheduleBeatVisualRef.current(beat.beat, beat.count, false, delaySeconds);
        beatCursor += 1;
      }
      if (scheduleCursor >= scheduledNotes.length && beatCursor >= scheduledBeats.length && playSchedulerRef.current !== null) {
        window.clearInterval(playSchedulerRef.current);
        playSchedulerRef.current = null;
      }
    };
    scheduleWindow();
    playSchedulerRef.current = window.setInterval(scheduleWindow, 80);

    const finishDelay = Math.max(20, (playbackWait + endSeconds - startSeconds) * 1000);
    playTimersRef.current.push(window.setTimeout(() => {
      if (projectRef.current.view.loop) startPlaybackRef.current(Math.max(0, projectRef.current.view.loopStart));
      else {
        clearPlayback();
        setPlayhead(endTick);
      }
    }, finishDelay));

    const follow = () => {
      const elapsed = Math.max(0, performance.now() / 1000 - playStartedRef.current.audioStartedAt);
      const tick = secondsToTick(startSeconds + elapsed, allTempoEvents, songDuration);
      setPlayhead(Math.min(endTick, tick));
      playRafRef.current = window.requestAnimationFrame(follow);
    };
    playRafRef.current = window.requestAnimationFrame(follow);
  }, [allTempoEvents, baseTempo, clearPlayback, clickMetronome, displayTracks, parseError, playMidi, playhead, project, releaseMidi, songDuration]);

  const startPlayback = useCallback((fromTick = playhead) => {
    if (parseError || !displayTracks.length) return;
    const themeIds = project.tracks.map((track: any) => track.themeId);
    clearPlayback();
    const generation = playbackGenerationRef.current;
    setPlaying(true);
    void prepareThemes(themeIds)
      .then(() => {
        if (playbackGenerationRef.current !== generation) return;
        schedulePlayback(fromTick);
      })
      .catch((error) => {
        if (playbackGenerationRef.current !== generation) return;
        clearPlayback();
        setRecordingMessage(t(error instanceof Error ? error.message : "음색을 준비하지 못했습니다."));
      });
  }, [clearPlayback, displayTracks.length, parseError, playhead, prepareThemes, project.tracks, schedulePlayback, t]);

  useEffect(() => {
    startPlaybackRef.current = startPlayback;
  }, [startPlayback]);

  useEffect(() => {
    const resumeTick = resumeAfterThemeChangeRef.current;
    if (resumeTick === null) return;
    resumeAfterThemeChangeRef.current = null;
    const frame = window.requestAnimationFrame(() => startPlaybackRef.current(resumeTick));
    return () => window.cancelAnimationFrame(frame);
  }, [project]);

  const updateRecordingPreview = useCallback(() => {
    const base = recordingBaseProjectRef.current;
    if (!base || !recordingActiveRef.current) return null;
    const origin = base.recording.mode === "realtime" ? recordingStartRef.current : 0;
    const preview = renderRecordingProject(base, recordingInputsRef.current, explicitRestsRef.current, {
      bpm: recordingTempoRef.current,
      quantizeBpm: base.recording.mode === "append" ? 60 : recordingTempoRef.current,
      origin,
      startTick: recordingStartTickRef.current,
    });
    setProject(preview.project);
    setDroppedCount(preview.result.dropped.length);
    const last = preview.result.assigned.at(-1)?.input;
    if (last) {
      const length = encodeDuration(last.duration).map((value: string) => `1/${value}`).join(" + ");
      setRecordingMessage(t("{note} · {length} 기록됨", { note: noteLabel(last.midi), length }));
    }
    return preview;
  }, [t]);

  const clearBeatVisualTimers = useCallback(() => {
    beatVisualTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    beatVisualTimersRef.current.clear();
    setMetronomeVisual((current) => ({ ...current, beat: -1, preparing: false }));
  }, []);

  const scheduleBeatVisual = useCallback((beat: number, count: number, preparing: boolean, delaySeconds = 0) => {
    const activate = window.setTimeout(() => {
      beatVisualTimersRef.current.delete(activate);
      setMetronomeVisual((current) => ({ beat, count, preparing, pulse: current.pulse + 1 }));
      const deactivate = window.setTimeout(() => {
        beatVisualTimersRef.current.delete(deactivate);
        setMetronomeVisual((current) => current.beat === beat && current.preparing === preparing
          ? { ...current, beat: -1 }
          : current);
      }, 150);
      beatVisualTimersRef.current.add(deactivate);
    }, Math.max(0, delaySeconds * 1000));
    beatVisualTimersRef.current.add(activate);
  }, []);

  const clearCountInClicks = useCallback(() => {
    countInClickTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    countInClickTimersRef.current.clear();
  }, []);

  const stopMetronomeClock = useCallback(() => {
    if (metronomeTimerRef.current !== null) window.clearTimeout(metronomeTimerRef.current);
    metronomeTimerRef.current = null;
    metronomeClockRef.current = null;
    standaloneMetronomeCancelsRef.current.forEach((cancel) => cancel());
    standaloneMetronomeCancelsRef.current.clear();
  }, []);

  const startMetronomeClock = useCallback((startAt: number, bpm: number, numerator: number, denominator: number) => {
    stopMetronomeClock();
    const beatSeconds = (60 / bpm) * (4 / denominator);
    metronomeClockRef.current = { startAt, beatSeconds };
    let beat = 0;
    let nextAt = startAt;
    const schedule = () => {
      if (!projectRef.current.recording.metronome) {
        metronomeTimerRef.current = null;
        metronomeClockRef.current = null;
        return;
      }
      const now = performance.now() / 1000;
      while (nextAt <= now + 0.28) {
        if (nextAt >= now - 0.04) {
          const delay = Math.max(0, nextAt - now);
          const cancel = clickMetronome(beat % numerator === 0, projectRef.current.recording.metronomeVolume, delay, false);
          standaloneMetronomeCancelsRef.current.add(cancel);
          window.setTimeout(() => standaloneMetronomeCancelsRef.current.delete(cancel), (delay + 0.2) * 1000);
          scheduleBeatVisual(beat % numerator, numerator, false, delay);
        }
        beat += 1;
        nextAt = startAt + beat * beatSeconds;
      }
      metronomeTimerRef.current = window.setTimeout(schedule, 70);
    };
    schedule();
  }, [clickMetronome, scheduleBeatVisual, stopMetronomeClock]);

  useEffect(() => {
    stopMetronomeClockRef.current = stopMetronomeClock;
    scheduleBeatVisualRef.current = scheduleBeatVisual;
    clearBeatVisualTimersRef.current = clearBeatVisualTimers;
  }, [clearBeatVisualTimers, scheduleBeatVisual, stopMetronomeClock]);

  useEffect(() => {
    if (!hydrated || !project.recording.metronome || playing) {
      stopMetronomeClock();
      if (!playing) clearBeatVisualTimers();
      return;
    }
    startMetronomeClock(performance.now() / 1000 + 0.04, recordTempo, recordMeter.numerator, recordMeter.denominator);
    return stopMetronomeClock;
  }, [clearBeatVisualTimers, hydrated, playing, project.recording.metronome, recordMeter.denominator, recordMeter.numerator, recordTempo, startMetronomeClock, stopMetronomeClock]);

  const toggleMetronome = useCallback(() => {
    setProject((current: any) => {
      const next = clone(current);
      next.recording.metronome = !current.recording.metronome;
      if (!next.recording.metronome) {
        playbackMetronomeCancelsRef.current.forEach((cancel) => cancel());
        playbackMetronomeCancelsRef.current.clear();
        clearBeatVisualTimersRef.current();
      }
      projectRef.current = next;
      if (recordingBaseProjectRef.current) recordingBaseProjectRef.current.recording.metronome = next.recording.metronome;
      return next;
    });
  }, []);

  const finishRecording = useCallback(() => {
    setRestInputActive(false);
    if (countInTimerRef.current !== null) window.clearTimeout(countInTimerRef.current);
    countInTimerRef.current = null;
    clearCountInClicks();
    clearBeatVisualTimers();
    window.cancelAnimationFrame(recordingRafRef.current);
    recordingArmedRef.current = false;
    const base = recordingBaseProjectRef.current;
    if (!base || !recordingActiveRef.current) {
      recordingActiveRef.current = false;
      activeRecordingRef.current.clear();
      recordingBaseProjectRef.current = null;
      setLiveRecordingNotes([]);
      setRecordState("idle");
      setRecordingMessage(t("녹음을 취소했습니다."));
      if (projectRef.current.recording.metronome) {
        startMetronomeClock(performance.now() / 1000 + 0.04, recordTempo, projectRef.current.timeSignature.numerator, projectRef.current.timeSignature.denominator);
      }
      return;
    }
    const wallEndedAt = performance.now() / 1000;
    activeRecordingRef.current.forEach((input) => {
      const endedAt = base.recording.mode === "append"
        ? appendTimelineSecondsAt(wallEndedAt)
        : recordingInputEndAt(base.recording.mode, wallEndedAt, appendCursorRef.current, appendWallStartRef.current);
      recordingInputsRef.current.push({ ...input, endedAt });
    });
    activeRecordingRef.current.clear();
    setLiveRecordingNotes([]);
    recordingActiveRef.current = false;
    const origin = base.recording.mode === "realtime" ? recordingStartRef.current : 0;
    const preview = renderRecordingProject(base, recordingInputsRef.current, explicitRestsRef.current, {
      bpm: recordingTempoRef.current,
      quantizeBpm: base.recording.mode === "append" ? 60 : recordingTempoRef.current,
      origin,
      startTick: recordingStartTickRef.current,
      sessionEndedAt: wallEndedAt,
    });
    const hasRecording = recordingInputsRef.current.length > 0
      || explicitRestsRef.current.length > 0
      || (base.recording.mode === "realtime" && preview.recordedEndTick > 0);
    if (hasRecording) {
      setPast((items) => [...items.slice(-99), clone(base)]);
      setFuture([]);
      setProject(preview.project);
    } else {
      setProject(base);
    }
    const finalTick = recordingStartTickRef.current + preview.recordedEndTick;
    playheadRef.current = finalTick;
    setPlayhead(finalTick);
    setDroppedCount(preview.result.dropped.length);
    setRecordingMessage(preview.result.dropped.length
      ? t("{count}개 음은 연결된 트랙이 부족해 기록하지 않았습니다.", { count: preview.result.dropped.length })
      : t("{count}개 음을 기록했습니다.", { count: preview.result.assigned.length }));
    setRecordState("idle");
    recordingBaseProjectRef.current = null;
    recordingInputsRef.current = [];
    explicitRestsRef.current = [];
    restStartedRef.current = null;
    appendWallStartRef.current = null;
  }, [appendTimelineSecondsAt, clearBeatVisualTimers, clearCountInClicks, recordTempo, startMetronomeClock, t]);

  const beginRecording = useCallback(() => {
    setRestInputActive(false);
    if (parseError) return;
    clearPlayback();
    const current = clone(projectRef.current);
    const currentParsedTracks = current.tracks.map((track: any, index: number) => {
      try {
        return parseTrack(track.sourceText);
      } catch {
        return displayTracks[index] ?? { duration: 0, tempos: [] };
      }
    });
    const currentTempoEvents = currentParsedTracks.flatMap((track: any) => track.tempos).sort((a: any, b: any) => a.tick - b.tick);
    const routedIds = new Set([...current.routing.left, ...current.routing.right]);
    const routedTrackIndexes = current.tracks
      .map((track: any, index: number) => routedIds.has(track.id) ? index : -1)
      .filter((index: number) => index >= 0);
    if (!routedTrackIndexes.length) {
      const selectedIndex = current.tracks.findIndex((track: any) => track.id === current.view.selectedTrackId);
      if (selectedIndex >= 0) routedTrackIndexes.push(selectedIndex);
    }
    const requestedStartTick = resolveRecordingStartTick(
      current.recording.startPosition,
      playheadRef.current,
      currentParsedTracks.map((track: any) => track.duration),
      routedTrackIndexes,
    );
    const startTick = snapTickToGrid(requestedStartTick, current.recording.quantize);
    const defaultTempo = tempoAtTick(0, currentTempoEvents, 120);
    const bpm = tempoAtTick(startTick, currentTempoEvents, defaultTempo);
    recordingBaseProjectRef.current = current;
    recordingTempoRef.current = bpm;
    recordingDefaultTempoRef.current = defaultTempo;
    recordingTempoEventsRef.current = currentTempoEvents;
    recordingInputsRef.current = [];
    activeRecordingRef.current.clear();
    explicitRestsRef.current = [];
    appendCursorRef.current = 0;
    recordingStartTickRef.current = startTick;
    playheadRef.current = startTick;
    setPlayhead(startTick);
    appendWallStartRef.current = null;
    recordingActiveRef.current = false;
    recordingArmedRef.current = false;
    setLiveRecordingNotes([]);
    setDroppedCount(0);

    const begin = (plannedStart: number) => {
      recordingStartRef.current = plannedStart;
      activeRecordingRef.current.forEach((input, inputId) => {
        activeRecordingRef.current.set(inputId, {
          ...input,
          startedAt: armedInputStartAt(current.recording.mode, plannedStart, input.startedAt),
        });
      });
      if (current.recording.mode === "append" && activeRecordingRef.current.size > 0) appendWallStartRef.current = plannedStart;
      recordingArmedRef.current = false;
      recordingActiveRef.current = true;
      setRecordState("recording");
      setRecordingMessage(t("{mode} 녹음 중 · {bpm} BPM", { mode: t(current.recording.mode === "realtime" ? "실시간" : "이어붙이기"), bpm }));
      if (current.recording.mode === "realtime" && current.recording.metronome) {
        startMetronomeClock(plannedStart, bpm, current.timeSignature.numerator, current.timeSignature.denominator);
      } else if (current.recording.mode === "realtime") {
        clearBeatVisualTimers();
      }
      const follow = () => {
        if (!recordingActiveRef.current) return;
        const now = performance.now() / 1000;
        const elapsed = current.recording.mode === "realtime"
          ? Math.max(0, now - recordingStartRef.current)
          : appendTimelineSecondsAt(now);
        const elapsedTick = recordingStartTickRef.current + Math.round(elapsed * TICKS_PER_QUARTER * (current.recording.mode === "append" ? 1 : bpm / 60));
        const timelineNow = current.recording.mode === "realtime" ? now : elapsed;
        const origin = current.recording.mode === "realtime" ? recordingStartRef.current : 0;
        const inputTempo = current.recording.mode === "append" ? 60 : bpm;
        const activeInputs = [...activeRecordingRef.current.values()];
        const nextLiveNotes = activeInputs.map((input) => {
          const range = liveInputTicks(input, timelineNow, inputTempo, origin, recordingStartTickRef.current);
          const trackId = current.routing[input.side]?.[0];
          const track = current.tracks.find((item: any) => item.id === trackId) ?? current.tracks[0];
          return { id: input.id, midi: input.midi, tick: range.tick, duration: range.duration, color: track?.color ?? "#ef6b5a" };
        });
        const tick = current.recording.mode === "append"
          ? liveNotesEndTick(nextLiveNotes, elapsedTick)
          : elapsedTick;
        playheadRef.current = tick;
        setPlayhead(tick);
        setLiveRecordingNotes((notes) => nextLiveNotes.length || notes.length ? nextLiveNotes : notes);
        recordingRafRef.current = window.requestAnimationFrame(follow);
      };
      recordingRafRef.current = window.requestAnimationFrame(follow);
    };

    const now = performance.now() / 1000;
    const plan = recordingStartPlan({
      mode: current.recording.mode,
      countIn: current.recording.countIn,
      now,
      bpm,
      timeSignature: current.timeSignature,
      metronomeClock: current.recording.metronome ? metronomeClockRef.current : null,
    });
    if (current.recording.mode === "realtime") stopMetronomeClock();
    if (plan.waitsForStart) {
      recordingArmedRef.current = true;
      setRecordState("count-in");
      setRecordingMessage(current.recording.countIn > 0
        ? t("{count}마디 카운트인 · {bpm} BPM", { count: current.recording.countIn, bpm })
        : t("다음 박자 대기 · {bpm} BPM", { bpm }));
      const nowAtSchedule = performance.now() / 1000;
      countInBeats(plan.plannedStart, bpm, current.timeSignature, current.recording.countIn).forEach((item) => {
        const delay = Math.max(0, item.at - nowAtSchedule);
        const lead = Math.min(0.08, delay);
        const timer = window.setTimeout(() => {
          countInClickTimersRef.current.delete(timer);
          clickMetronome(item.accent, current.recording.metronomeVolume, lead, true);
          scheduleBeatVisual(item.beat, item.count, true, lead);
        }, Math.max(0, (delay - lead) * 1000));
        countInClickTimersRef.current.add(timer);
      });
      countInTimerRef.current = window.setTimeout(() => begin(plan.plannedStart), Math.max(0, (plan.plannedStart - performance.now() / 1000) * 1000));
    } else {
      begin(plan.plannedStart);
    }
  }, [appendTimelineSecondsAt, clearBeatVisualTimers, clearPlayback, clickMetronome, displayTracks, parseError, scheduleBeatVisual, startMetronomeClock, stopMetronomeClock, t]);

  const beginRestInput = useCallback((at: number) => {
    const current = projectRef.current;
    if (!recordingActiveRef.current || current.recording.mode !== "append") {
      setRecordingMessage(t("쉼표는 이어붙이기 녹음 중에 길게 눌러 입력합니다."));
      return;
    }
    if (restStartedRef.current !== null) return;
    if (activeRecordingRef.current.size > 0) {
      setRecordingMessage(t("음을 누르는 동안에는 쉼표를 입력할 수 없습니다."));
      return;
    }
    if (appendWallStartRef.current === null) appendWallStartRef.current = at;
    restStartedRef.current = appendTimelineSecondsAt(at);
    setRestInputActive(true);
    setRecordingMessage(t("쉼표 입력 중"));
  }, [appendTimelineSecondsAt, t]);

  const finishRestInput = useCallback((at: number) => {
    setRestInputActive(false);
    const current = projectRef.current;
    if (!recordingActiveRef.current || current.recording.mode !== "append" || restStartedRef.current === null) return;
    const end = appendTimelineSecondsAt(at);
    const restEndTick = quantizedInputsEndTick([{
      id: "append-rest",
      side: "left",
      midi: 60,
      startedAt: restStartedRef.current,
      endedAt: end,
    }], 60, current.recording.quantize, 0);
    const settledEnd = ticksToRecordingSeconds(restEndTick, 60);
    explicitRestsRef.current.push({ start: restStartedRef.current, end: settledEnd });
    restStartedRef.current = null;
    if (activeRecordingRef.current.size === 0) {
      appendCursorRef.current = settledEnd;
      appendWallStartRef.current = null;
      const absoluteTick = recordingStartTickRef.current + restEndTick;
      playheadRef.current = absoluteTick;
      setPlayhead(absoluteTick);
    }
    setRecordingMessage(t("이어붙이기 녹음 · {bpm} BPM", { bpm: recordingTempoRef.current }));
    updateRecordingPreview();
  }, [appendTimelineSecondsAt, t, updateRecordingPreview]);

  const sink = useMemo<MmlInputSink>(() => ({
    noteOn(inputId, side, midi, at) {
      if ((!recordingActiveRef.current && !recordingArmedRef.current) || activeRecordingRef.current.has(inputId)) return;
      const current = projectRef.current;
      const routedTracks = new Set([
        ...current.routing[side],
        ...[...activeRecordingRef.current.values()].flatMap((input) => current.routing[input.side] ?? []),
      ]);
      if (current.routing[side].length === 0) {
        setRecordingMessage(t("{side} 건반에 연결된 트랙이 없습니다.", { side: t(side === "left" ? "왼쪽" : "오른쪽") }));
      } else if (activeRecordingRef.current.size + 1 > routedTracks.size) {
        setRecordingMessage(t("동시에 누른 음보다 연결된 트랙이 적습니다."));
      }
      let startedAt = at;
      if (recordingActiveRef.current && current.recording.mode === "append") {
        if (appendWallStartRef.current === null) appendWallStartRef.current = at;
        startedAt = appendTimelineSecondsAt(at);
      }
      activeRecordingRef.current.set(inputId, {
        id: `${inputId}:${at}`,
        inputId,
        side,
        midi,
        startedAt,
        velocityByTrack: Object.fromEntries(current.tracks.map((track: any) => [
          track.id,
          Math.max(0, Math.min(15, Number(track.recordVelocity) || 0)),
        ])),
      });
    },
    noteOff(inputId, at) {
      const active = activeRecordingRef.current.get(inputId);
      if (!active) return;
      if (recordingArmedRef.current && !recordingActiveRef.current) {
        activeRecordingRef.current.delete(inputId);
        return;
      }
      const current = projectRef.current;
      let endedAt = at;
      if (current.recording.mode === "append") {
        endedAt = appendTimelineSecondsAt(at);
      }
      recordingInputsRef.current.push({ ...active, endedAt: Math.max(active.startedAt, endedAt) });
      activeRecordingRef.current.delete(inputId);
      const continuation = current.recording.mode === "append" && restStartedRef.current === null
        ? appendLegatoContinuation(
          recordingInputsRef.current,
          [...activeRecordingRef.current.values()],
          60,
          current.recording.quantize,
        )
        : null;
      if (continuation) {
        const settledAt = ticksToRecordingSeconds(continuation.settledTick, 60);
        const next = activeRecordingRef.current.get(continuation.inputId);
        if (next) activeRecordingRef.current.set(continuation.inputId, { ...next, startedAt: settledAt });
        appendCursorRef.current = settledAt;
        appendWallStartRef.current = at;
        const absoluteTick = recordingStartTickRef.current + continuation.settledTick;
        playheadRef.current = absoluteTick;
        setPlayhead(absoluteTick);
      } else if (current.recording.mode === "append" && activeRecordingRef.current.size === 0 && restStartedRef.current === null) {
        const settledTick = quantizedInputsEndTick(
          recordingInputsRef.current,
          60,
          current.recording.quantize,
          0,
        );
        appendCursorRef.current = ticksToRecordingSeconds(settledTick, 60);
        appendWallStartRef.current = null;
        const absoluteTick = recordingStartTickRef.current + settledTick;
        playheadRef.current = absoluteTick;
        setPlayhead(absoluteTick);
      }
      setLiveRecordingNotes((notes) => notes.filter((note) => note.id !== active.id));
      updateRecordingPreview();
    },
    restOn(at) {
      beginRestInput(at);
    },
    restOff(at) {
      finishRestInput(at);
    },
  }), [appendTimelineSecondsAt, beginRestInput, finishRestInput, t, updateRecordingPreview]);

  useEffect(() => {
    registerInputSink(sink);
    return () => registerInputSink(null);
  }, [registerInputSink, sink]);

  useEffect(() => {
    if (!visible || !sourceSelection) return;
    const dismissSelection = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target === editorRef.current || target?.closest(".mml-note-block")) return;
      clearSourceSelection();
    };
    document.addEventListener("pointerdown", dismissSelection, true);
    return () => document.removeEventListener("pointerdown", dismissSelection, true);
  }, [clearSourceSelection, sourceSelection, visible]);

  useEffect(() => {
    if (!visible) return;
    const down = (event: KeyboardEvent) => {
      const typing = Boolean((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === "Comma" || event.code === "Period")) {
        const editor = editorRef.current;
        if (event.target === editor && editor && editor.selectionStart !== editor.selectionEnd) {
          event.preventDefault();
          shiftEditorSelectionDuration(event.code === "Comma" ? -1 : 1);
        }
        return;
      }
      if (typing && event.target !== editorRef.current) return;
      const shortcuts = Object.assign({
        play: "Space",
        record: "Alt+KeyR",
        stop: "Alt+KeyS",
      }, projectRef.current.recording.shortcuts ?? {});
      if (matchesShortcut(event, shortcuts.play)) {
        event.preventDefault();
        if (event.repeat || recordState !== "idle") return;
        if (playing) clearPlayback(); else startPlayback();
        return;
      }
      if (matchesShortcut(event, shortcuts.record)) {
        event.preventDefault();
        if (recordState === "idle") beginRecording(); else finishRecording();
        return;
      }
      if (matchesShortcut(event, shortcuts.stop)) {
        event.preventDefault();
        clearPlayback();
        if (recordState !== "idle") finishRecording();
        playheadRef.current = 0;
        setPlayhead(0);
        return;
      }
      const current = projectRef.current;
      if (typing || event.repeat || recordState !== "recording" || current.recording.mode !== "append" || event.code !== current.recording.restKey) return;
      event.preventDefault();
      beginRestInput(performance.now() / 1000);
    };
    const up = (event: KeyboardEvent) => {
      const current = projectRef.current;
      if (recordState !== "recording" || current.recording.mode !== "append" || event.code !== current.recording.restKey || restStartedRef.current === null) return;
      event.preventDefault();
      finishRestInput(performance.now() / 1000);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [beginRecording, beginRestInput, clearPlayback, finishRecording, finishRestInput, playing, recordState, redo, shiftEditorSelectionDuration, startPlayback, undo, visible]);

  useEffect(() => () => {
    clearPlayback();
    recordingActiveRef.current = false;
    recordingArmedRef.current = false;
    activeRecordingRef.current.clear();
    window.cancelAnimationFrame(recordingRafRef.current);
    window.cancelAnimationFrame(wheelZoomRef.current.frame);
    if (wheelZoomRef.current.commitTimer !== null) window.clearTimeout(wheelZoomRef.current.commitTimer);
    wheelZoomRef.current.frame = 0;
    wheelZoomRef.current.commitTimer = null;
    wheelZoomRef.current.timelineSteps = 0;
    wheelZoomRef.current.pitchSteps = 0;
    wheelZoomRef.current.timelineAnchor = null;
    wheelZoomRef.current.pitchAnchor = null;
    wheelZoomRef.current.activeUntil = 0;
    if (countInTimerRef.current !== null) window.clearTimeout(countInTimerRef.current);
    clearCountInClicks();
    clearBeatVisualTimers();
    stopMetronomeClock();
  }, [clearBeatVisualTimers, clearCountInClicks, clearPlayback, stopMetronomeClock]);

  const updateTrack = (id: string, patch: Record<string, unknown>) => {
    const recordingBase = recordingBaseProjectRef.current;
    if (recordingBase) {
      const baseTrack = recordingBase.tracks.find((item: any) => item.id === id);
      if (baseTrack) Object.assign(baseTrack, patch);
      setProject((current: any) => {
        const next = clone(current);
        const track = next.tracks.find((item: any) => item.id === id);
        if (track) Object.assign(track, patch);
        projectRef.current = next;
        syncTrackMix(trackMixStates(next.tracks));
        return next;
      });
      return;
    }
    commit((draft: any) => {
      const track = draft.tracks.find((item: any) => item.id === id);
      if (track) Object.assign(track, patch);
      projectRef.current = draft;
      syncTrackMix(trackMixStates(draft.tracks));
      return draft;
    });
  };

  const updateTracks = (ids: string[], patch: Record<string, unknown> | ((track: any) => void)) => {
    if (!ids.length) return;
    const selectedIds = new Set(ids);
    const apply = (track: any) => {
      if (!selectedIds.has(track.id)) return;
      if (typeof patch === "function") patch(track);
      else Object.assign(track, patch);
    };
    const recordingBase = recordingBaseProjectRef.current;
    if (recordingBase) {
      recordingBase.tracks.forEach(apply);
      setProject((current: any) => {
        const next = clone(current);
        next.tracks.forEach(apply);
        projectRef.current = next;
        syncTrackMix(trackMixStates(next.tracks));
        return next;
      });
      return;
    }
    commit((draft: any) => {
      draft.tracks.forEach(apply);
      projectRef.current = draft;
      syncTrackMix(trackMixStates(draft.tracks));
      return draft;
    });
  };

  const optimizeSelectedTrack = () => {
    try {
      const result = optimizeMmlText(selectedTrack.sourceText);
      if (!result.changed) {
        setRecordingMessage(t("이미 최적화된 텍스트입니다."));
        return;
      }
      commit((draft: any) => {
        const track = draft.tracks.find((item: any) => item.id === selectedTrack.id);
        if (!track) return draft;
        track.sourceText = result.source;
        return draft;
      });
      setRecordingMessage(t("{before}자 → {after}자 · {saved}자 줄임", { before: result.beforeLength, after: result.afterLength, saved: result.saved }));
      window.requestAnimationFrame(() => editorRef.current?.focus());
    } catch (error) {
      setRecordingMessage(t("최적화하지 못했습니다 · {message}", { message: (error as Error).message }));
    }
  };

  const expandSelectedTrack = () => {
    try {
      const result = expandMmlText(selectedTrack.sourceText);
      if (!result.changed) {
        setRecordingMessage("");
        return;
      }
      commit((draft: any) => {
        const track = draft.tracks.find((item: any) => item.id === selectedTrack.id);
        if (!track) return draft;
        track.sourceText = result.source;
        return draft;
      });
      setRecordingMessage("");
      window.requestAnimationFrame(() => editorRef.current?.focus());
    } catch (error) {
      setRecordingMessage((error as Error).message);
    }
  };

  const toggleBatchTrack = (trackId: string) => {
    setSettingsView(false);
    setTrackSettingsView(false);
    setFileMenuView(false);
    setBatchTrackIds((current) => current.includes(trackId)
      ? current.filter((id) => id !== trackId)
      : [...current, trackId]);
  };

  const toggleAllBatchTracks = () => {
    setSettingsView(false);
    setTrackSettingsView(false);
    setFileMenuView(false);
    setBatchTrackIds((current) => current.length > 0
      ? []
      : project.tracks.map((track: any) => track.id));
  };

  const changeTrackThemes = (trackIds: string[], themeId: string) => {
    if (!themeId || trackIds.length === 0) return;
    if (playing) {
      resumeAfterThemeChangeRef.current = playheadRef.current;
      clearPlayback();
    }
    updateTracks(trackIds, { themeId });
  };

  const openBatchSettings = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const studio = event.currentTarget.closest(".mml-studio") as HTMLElement | null;
    const panel = event.currentTarget.closest(".mml-track-list-title") as HTMLElement | null;
    let anchor: { x: number; y: number } | null = null;
    if (studio && panel && studio.clientWidth > 680) {
      const studioRect = studio.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      anchor = {
        x: panelRect.right - studioRect.left + 10,
        y: panelRect.top - studioRect.top,
      };
    }
    setSettingsView(false);
    setTrackSettingsView(false);
    setTrackSettingsAnchor(null);
    setFileMenuView(false);
    setBatchSettingsAnchor(anchor);
    setBatchSettingsView(true);
  };

  const transposeTrackTexts = (trackIds: string[], delta: number) => {
    if (!trackIds.length || !delta || recordState !== "idle") return;
    try {
      const selectedIds = new Set(trackIds);
      const transposedTexts = new Map(
        project.tracks
          .filter((track: any) => selectedIds.has(track.id))
          .map((track: any) => [track.id, transposeMmlText(track.sourceText, delta)]),
      );
      commit((draft: any) => {
        draft.tracks.forEach((track: any) => {
          if (transposedTexts.has(track.id)) track.sourceText = transposedTexts.get(track.id);
        });
        return draft;
      });
      setRecordingMessage(t("{count}개 트랙을 {delta}반음 이조했습니다.", { count: transposedTexts.size, delta: `${delta > 0 ? "+" : ""}${delta}` }));
    } catch (error) {
      setRecordingMessage(t((error as Error).message || "이조하지 못했습니다."));
    }
  };

  const beginTrackDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement | null)?.closest(".mml-track-reorder-handle")) return;
    if (event.pointerType !== "touch") return;
    trackDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      axis: null,
      scrollLeft: event.currentTarget.scrollLeft,
      targetScrollLeft: event.currentTarget.scrollLeft,
      frame: 0,
      dragging: false,
    };
  };

  const moveTrackDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = trackDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.axis) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 6) return;
      drag.axis = Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
      drag.dragging = true;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic test events and older WebViews can omit pointer capture.
    }
    const delta = drag.axis === "x" ? deltaX : deltaY;
    drag.targetScrollLeft = drag.scrollLeft - delta;
    if (!drag.frame) {
      const trackList = event.currentTarget;
      drag.frame = window.requestAnimationFrame(() => {
        const current = trackDragRef.current;
        if (!current || current.pointerId !== event.pointerId) return;
        trackList.scrollLeft = current.targetScrollLeft;
        current.frame = 0;
      });
    }
  };

  const endTrackDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = trackDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame) window.cancelAnimationFrame(drag.frame);
    event.currentTarget.scrollLeft = drag.targetScrollLeft;
    if (drag.dragging) {
      suppressTrackClickRef.current = true;
      window.setTimeout(() => { suppressTrackClickRef.current = false; }, 0);
    }
    trackDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional for taps and synthetic events.
    }
  };

  const scrollTrackListWithWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
    const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += delta;
  };

  const reorderTrack = (trackId: string, targetId: string, placement: "before" | "after") => {
    commit((draft: any) => reorderProjectTrack(draft, trackId, targetId, placement));
  };

  const beginTrackReorder = (event: ReactPointerEvent<HTMLButtonElement>, trackId: string) => {
    if (recordState !== "idle") return;
    const list = event.currentTarget.closest(".mml-track-list") as HTMLElement | null;
    if (!list) return;
    const touchPointer = event.pointerType === "touch";
    event.preventDefault();
    event.stopPropagation();

    let drag: NonNullable<typeof trackReorderRef.current>;
    const updateTarget = (clientX: number, clientY: number) => {
      if (trackReorderRef.current !== drag) return;
      const listRect = drag.list.getBoundingClientRect();
      const horizontal = getComputedStyle(drag.list).display === "flex";
      const edge = 28;
      if (horizontal) {
        if (clientX < listRect.left + edge) drag.list.scrollLeft -= 14;
        else if (clientX > listRect.right - edge) drag.list.scrollLeft += 14;
      } else {
        if (clientY < listRect.top + edge) drag.list.scrollTop -= 14;
        else if (clientY > listRect.bottom - edge) drag.list.scrollTop += 14;
      }
      const card = document.elementFromPoint(clientX, clientY)?.closest(".mml-track-card") as HTMLElement | null;
      const targetId = card?.dataset.trackId ?? null;
      if (!card || !targetId || targetId === drag.trackId) {
        if (drag.targetId !== null) {
          drag.targetId = null;
          setTrackReorder({ trackId: drag.trackId, targetId: null, placement: drag.placement });
        }
        return;
      }
      const rect = card.getBoundingClientRect();
      const placement = horizontal
        ? (clientX < rect.left + rect.width / 2 ? "before" : "after")
        : (clientY < rect.top + rect.height / 2 ? "before" : "after");
      if (drag.targetId === targetId && drag.placement === placement) return;
      drag.targetId = targetId;
      drag.placement = placement;
      setTrackReorder({ trackId: drag.trackId, targetId, placement });
    };
    const finish = (pointerId: number) => {
      if (trackReorderRef.current !== drag || drag.pointerId !== pointerId) return;
      const { targetId, placement } = drag;
      drag.cleanup();
      trackReorderRef.current = null;
      setTrackReorder(null);
      if (targetId) reorderTrack(drag.trackId, targetId, placement);
    };
    const onPointerMove = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== drag.pointerId) return;
      nativeEvent.preventDefault();
      updateTarget(nativeEvent.clientX, nativeEvent.clientY);
    };
    const onPointerEnd = (nativeEvent: PointerEvent) => finish(nativeEvent.pointerId);
    const onPointerCancel = (nativeEvent: PointerEvent) => {
      if (!touchPointer) finish(nativeEvent.pointerId);
    };
    const onTouchMove = (nativeEvent: TouchEvent) => {
      const touch = nativeEvent.touches[0] ?? nativeEvent.changedTouches[0];
      if (!touch || trackReorderRef.current !== drag) return;
      nativeEvent.preventDefault();
      updateTarget(touch.clientX, touch.clientY);
    };
    const onTouchEnd = () => finish(drag.pointerId);
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchEnd, true);
      document.documentElement.classList.remove("is-track-reordering");
      try { drag.handle.releasePointerCapture(drag.pointerId); } catch { /* optional */ }
    };
    drag = {
      pointerId: event.pointerId,
      trackId,
      targetId: null,
      placement: "before",
      list,
      handle: event.currentTarget,
      cleanup,
    };
    trackReorderRef.current?.cleanup();
    trackReorderRef.current = drag;
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    if (touchPointer) {
      window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      window.addEventListener("touchend", onTouchEnd, true);
      window.addEventListener("touchcancel", onTouchEnd, true);
    }
    document.documentElement.classList.add("is-track-reordering");
    if (touchPointer) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional */ }
    }
    setTrackReorder({ trackId, targetId: null, placement: "before" });
  };

  const moveTrackWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, trackId: string, index: number) => {
    const backwards = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const forwards = event.key === "ArrowDown" || event.key === "ArrowRight";
    if (!backwards && !forwards) return;
    event.preventDefault();
    const targetIndex = index + (backwards ? -1 : 1);
    const target = project.tracks[targetIndex];
    if (!target) return;
    reorderTrack(trackId, target.id, backwards ? "before" : "after");
  };

  const updateMasterTempo = (value: number) => {
    const bpm = Math.max(1, Math.round(value || 1));
    commit((draft: any) => {
      const track = draft.tracks.find((item: any) => item.id === draft.view.selectedTrackId) ?? draft.tracks[0];
      if (track) track.sourceText = upsertTempoCommand(track.sourceText, 0, bpm);
      return draft;
    });
  };

  const writeTimelineTempoToCode = (draft: any, trackId: string, tick: number, bpm: number) => {
    const track = draft.tracks.find((item: any) => item.id === trackId) ?? draft.tracks[0];
    if (track) track.sourceText = upsertTempoCommand(track.sourceText, tick, bpm);
  };

  const deleteTimelineTempoFromCode = (draft: any, trackId: string, tick: number) => {
    const track = draft.tracks.find((item: any) => item.id === trackId);
    if (track) track.sourceText = deleteTempoCommand(track.sourceText, tick);
  };

  const captureShortcut = (action: "play" | "record" | "stop", event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = shortcutFromEvent(event);
    const collision = Object.entries(recordingShortcuts).find(([name, value]) => name !== action && value === shortcut);
    if (collision) {
      window.alert(t("이미 다른 MML 기능에 사용 중인 단축키입니다."));
      return;
    }
    commit((draft: any) => {
      draft.recording.shortcuts = { ...recordingShortcuts, [action]: shortcut };
      return draft;
    });
  };

  const toggleRoute = (side: KeyboardSide, trackId: string) => commit((draft: any) => {
    const route = draft.routing[side];
    draft.routing[side] = route.includes(trackId) ? route.filter((id: string) => id !== trackId) : [...route, trackId];
    return draft;
  });

  const addTrack = () => commit((draft: any) => {
    const track = createTrack(draft.tracks.length, currentThemeId);
    draft.tracks.push(track);
    draft.view.selectedTrackId = track.id;
    return draft;
  });

  const removeTrack = (trackId: string) => {
    if (project.tracks.length <= 1) return;
    commit((draft: any) => {
      const index = draft.tracks.findIndex((track: any) => track.id === trackId);
      draft.tracks.splice(index, 1);
      draft.routing.left = draft.routing.left.filter((id: string) => id !== trackId);
      draft.routing.right = draft.routing.right.filter((id: string) => id !== trackId);
      if (draft.view.selectedTrackId === trackId) draft.view.selectedTrackId = draft.tracks[Math.max(0, index - 1)].id;
      return draft;
    });
  };

  const selectTrack = (trackId: string) => {
    if (recordingBaseProjectRef.current) {
      recordingBaseProjectRef.current.view.selectedTrackId = trackId;
    }
    setProject((current: any) => {
      const next = {
        ...current,
        view: { ...current.view, selectedTrackId: trackId },
      };
      projectRef.current = next;
      return next;
    });
  };

  const openTrackSettings = (trackId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const studio = event.currentTarget.closest(".mml-studio") as HTMLElement | null;
    const card = event.currentTarget.closest(".mml-track-card") as HTMLElement | null;
    let anchor: { x: number; y: number } | null = null;
    if (studio && card && studio.clientWidth > 680) {
      const studioRect = studio.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      anchor = {
        x: cardRect.right - studioRect.left + 10,
        y: cardRect.top - studioRect.top,
      };
    }
    selectTrack(trackId);
    setTrackSettingsAnchor(anchor);
    setTrackSettingsView(true);
    setBatchSettingsView(false);
    setBatchSettingsAnchor(null);
    setSettingsView(false);
    setFileMenuView(false);
  };

  useLayoutEffect(() => {
    if (!trackSettingsView || !trackSettingsAnchor) return;
    const dialog = trackSettingsRef.current;
    const parent = dialog?.offsetParent as HTMLElement | null;
    if (!dialog || !parent) return;
    const maxX = Math.max(8, parent.clientWidth - dialog.offsetWidth - 8);
    const maxY = Math.max(8, parent.clientHeight - dialog.offsetHeight - 8);
    const x = Math.max(8, Math.min(trackSettingsAnchor.x, maxX));
    const y = Math.max(8, Math.min(trackSettingsAnchor.y, maxY));
    if (x === trackSettingsAnchor.x && y === trackSettingsAnchor.y) return;
    setTrackSettingsAnchor({ x, y });
  }, [trackSettingsAnchor, trackSettingsView]);

  useLayoutEffect(() => {
    if (!batchSettingsView || !batchSettingsAnchor) return;
    const dialog = batchSettingsRef.current;
    const parent = dialog?.offsetParent as HTMLElement | null;
    if (!dialog || !parent) return;
    const maxX = Math.max(8, parent.clientWidth - dialog.offsetWidth - 8);
    const maxY = Math.max(8, parent.clientHeight - dialog.offsetHeight - 8);
    const x = Math.max(8, Math.min(batchSettingsAnchor.x, maxX));
    const y = Math.max(8, Math.min(batchSettingsAnchor.y, maxY));
    if (x === batchSettingsAnchor.x && y === batchSettingsAnchor.y) return;
    setBatchSettingsAnchor({ x, y });
  }, [batchSettingsAnchor, batchSettingsView]);

  const selectPianoNote = (trackIndex: number, note: any) => {
    const track = project.tracks[trackIndex];
    selectTrack(track.id);
    setSourceSelection({ trackId: track.id, start: note.sourceStart, end: note.sourceEnd });
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(note.sourceStart, note.sourceEnd);
    });
  };

  const replaceLoadedProject = useCallback((value: any) => {
    clearPlayback();
    const next = sanitizeProject(value, currentThemeId);
    projectRef.current = next;
    setProject(next);
    setPast([]);
    setFuture([]);
    setBatchTrackIds([]);
    playheadRef.current = 0;
    setPlayhead(0);
    setTimelineEditor(null);
    setRecordingMessage("");
    setDroppedCount(0);
    setFileMenuView(false);
    setImportPayload(null);
  }, [clearPlayback, currentThemeId]);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearPlayback();
    try {
      if (/\.(mid|midi)$/i.test(file.name)) {
        if (!window.confirm(t("현재 작업을 MIDI 파일의 곡으로 바꿀까요?"))) return;
        const fallbackTitle = file.name.replace(/\.(mid|midi)$/i, "");
        const imported = createProjectFromMidi(await file.arrayBuffer(), currentThemeId, fallbackTitle);
        replaceLoadedProject(imported);
        return;
      }
      const fileBytes = await file.arrayBuffer();
      const text = decodeThreeMleFile(fileBytes);
      if (file.name.toLowerCase().endsWith(".nyangmml")) {
        if (!window.confirm(t("현재 작업을 불러온 프로젝트로 바꿀까요?"))) return;
        replaceLoadedProject(JSON.parse(text));
        return;
      }
      if (file.name.toLowerCase().endsWith(".mmi")) {
        if (!window.confirm(t("현재 작업을 마비꼬 파일의 곡으로 바꿀까요?"))) return;
        const fallbackTitle = file.name.replace(/\.mmi$/i, "");
        replaceLoadedProject(createProjectFromMmi(text, currentThemeId, fallbackTitle));
        return;
      }
      if (isThreeMleDocument(text)) {
        const imported = parseThreeMleDocument(text);
        setImportPayload({
          ranges: imported.channels.map((channel) => channel.sourceText),
          trackNames: imported.channels.map((channel) => channel.name),
          replacementTitle: imported.title.trim() || importedMmlTitle(file.name),
          importSource: { format: imported.format },
        });
        setFileMenuView(false);
        return;
      }
      const parsed = parseMmlDocument(text);
      const ranges = parsed.tracks.map((track: any) => text.slice(track.sourceStart, track.sourceEnd));
      setImportPayload({ ranges, replacementTitle: importedMmlTitle(file.name) });
      setFileMenuView(false);
    } catch (error) {
      window.alert(t("파일을 불러오지 못했습니다.\n{message}", { message: (error as Error).message }));
    }
  };

  const applyImport = (mode: "replace" | "append" | "tracks" | "selected") => {
    if (!importPayload) return;
    clearPlayback();
    const next = applyMmlImport(projectRef.current, importPayload, mode, currentThemeId);
    if (mode === "replace") {
      replaceLoadedProject(next);
    } else {
      commit(next);
      setImportPayload(null);
    }
  };

  const resetProject = () => {
    if (!window.confirm(t("현재 작업을 비우고 새 프로젝트를 만들까요?"))) return;
    clearPlayback();
    const next = createProject(currentThemeId);
    setProject(next);
    setPast([]);
    setFuture([]);
    setPlayhead(0);
    playheadRef.current = 0;
    setRecordingMessage("");
    setDroppedCount(0);
    setFileMenuView(false);
  };

  const exportProject = () => saveBlob(projectFilename(project), "application/json", JSON.stringify(project, null, 2));
  const exportMml = () => {
    const name = project.title.trim().replace(/[\\/:*?"<>|]+/g, "-") || "nyangnyang";
    saveBlob(`${name}.mml`, "text/plain;charset=utf-8", combineTracks(project.tracks.map((track: any) => track.sourceText), { removeComments: true }));
  };
  const exportMidi = () => saveBlob(midiFilename(project), "audio/midi", createMidiFile(project));

  const pianoTimelineDuration = Math.max(
    songDuration,
    TICKS_PER_QUARTER * 16,
    recordState === "recording" ? playhead + TICKS_PER_QUARTER * 12 : 0,
  );
  const unscaledPianoWidth = pianoTimelineDuration * PIANO_PIXELS_PER_TICK;
  const fitTimelineScale = pianoViewportWidth > 0
    ? Math.max(1, (pianoViewportWidth + 1) / unscaledPianoWidth)
    : 1;
  const minimumTimelineZoom = pianoViewportWidth > 0
    ? clampTimelineZoom((pianoViewportWidth + 1) / (unscaledPianoWidth * fitTimelineScale))
    : 0.5;
  const clampPianoTimelineZoom = (value: number) => Math.max(minimumTimelineZoom, clampTimelineZoom(value));
  const pianoRenderZoom = timelineZoom * fitTimelineScale;
  const pianoPixelsPerTick = PIANO_PIXELS_PER_TICK * pianoRenderZoom;
  const pianoWidth = pianoTimelineDuration * pianoPixelsPerTick;
  const timelineGrid = buildTimelineGrid(pianoTimelineDuration, project.timeSignatureMap, project.timeSignature);
  const timelineChangeTicks = [...new Set([
    ...trackTempoEvents.map((marker: any) => marker.tick),
    ...project.timeSignatureMap.map((marker: any) => marker.tick),
  ])].sort((a, b) => a - b);
  const songMeasures = timelineGrid.measures.filter((measure: any) => measure.tick < songDuration);
  const loopStartMeasure = Math.max(1, songMeasures.findLastIndex((measure: any) => measure.tick <= project.view.loopStart) + 1);
  const effectiveLoopEnd = project.view.loopEnd > project.view.loopStart ? Math.min(project.view.loopEnd, songDuration) : songDuration;
  const loopEndBoundary = timelineGrid.measures.findIndex((measure: any) => measure.tick >= effectiveLoopEnd);
  const loopEndMeasure = Math.max(loopStartMeasure, loopEndBoundary > 0 ? loopEndBoundary : songMeasures.length);
  const tickToPianoX = (tick: number) => tick * pianoPixelsPerTick;
  const displayPixelRatio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const playheadX = Math.round(playhead * pianoPixelsPerTick * displayPixelRatio) / displayPixelRatio;
  const timelinePositionLabel = (tick: number) => {
    const measureIndex = Math.max(0, timelineGrid.measures.findLastIndex((measure: any) => measure.tick <= tick));
    const measure = timelineGrid.measures[measureIndex] ?? { tick: 0, number: 1, denominator: project.timeSignature.denominator };
    const beatTicks = (TICKS_PER_QUARTER * 4) / measure.denominator;
    const beat = Math.max(1, Math.floor((tick - measure.tick) / beatTicks) + 1);
    return t("{measure}마디 {beat}박", { measure: measure.number, beat });
  };
  const openTimelineEditor = (tick: number, anchor?: { x: number; y: number }) => {
    const safeTick = Math.max(0, Math.min(pianoTimelineDuration, Math.round(tick)));
    const selectedIndex = project.tracks.findIndex((track: any) => track.id === selectedTrack.id);
    const tempo = trackTempoEvents.find((marker: any) => marker.tick === safeTick && marker.trackIndex === selectedIndex)
      ?? trackTempoEvents.find((marker: any) => marker.tick === safeTick);
    const tempoTrackId = tempo ? project.tracks[tempo.trackIndex]?.id : selectedTrack.id;
    const meter = project.timeSignatureMap.find((marker: any) => marker.tick === safeTick)
      ?? [...project.timeSignatureMap].filter((marker: any) => marker.tick <= safeTick).at(-1)
      ?? project.timeSignature;
    setTimelineEditor({
      tick: safeTick,
      bpm: tempo?.bpm ?? tempoAtTick(safeTick, allTempoEvents, baseTempo),
      numerator: meter.numerator,
      denominator: meter.denominator,
      tempoTrackId,
      ...(anchor ?? (timelineEditor?.x !== undefined && timelineEditor?.y !== undefined ? { x: timelineEditor.x, y: timelineEditor.y } : {})),
    });
  };

  useLayoutEffect(() => {
    if (!timelineEditor || timelineEditor.x === undefined || timelineEditor.y === undefined) return;
    const dialog = timelineEditorRef.current;
    const parent = dialog?.offsetParent as HTMLElement | null;
    if (!dialog || !parent) return;
    const x = Math.max(8, Math.min(timelineEditor.x, parent.clientWidth - dialog.offsetWidth - 8));
    const y = Math.max(8, Math.min(timelineEditor.y, parent.clientHeight - dialog.offsetHeight - 8));
    if (x === timelineEditor.x && y === timelineEditor.y) return;
    setTimelineEditor((current) => current ? { ...current, x, y } : current);
  }, [timelineEditor]);
  const saveTimelineTempo = () => {
    if (!timelineEditor) return;
    const marker = { tick: timelineEditor.tick, bpm: Math.max(1, Math.round(timelineEditor.bpm || 1)) };
    commit((draft: any) => {
      writeTimelineTempoToCode(draft, timelineEditor.tempoTrackId, marker.tick, marker.bpm);
      return draft;
    });
    setRecordingMessage(t("{position}에 t{bpm} 코드를 저장했습니다.", { position: timelinePositionLabel(marker.tick), bpm: marker.bpm }));
  };
  const deleteTimelineTempo = () => {
    if (!timelineEditor) return;
    commit((draft: any) => {
      deleteTimelineTempoFromCode(draft, timelineEditor.tempoTrackId, timelineEditor.tick);
      return draft;
    });
    setRecordingMessage(t("{position}의 템포 코드를 삭제했습니다.", { position: timelinePositionLabel(timelineEditor.tick) }));
  };
  const saveTimelineMeter = () => {
    if (!timelineEditor) return;
    const marker = {
      tick: timelineEditor.tick,
      numerator: Math.max(1, Math.round(timelineEditor.numerator || 1)),
      denominator: Math.max(1, Math.round(timelineEditor.denominator || 1)),
    };
    commit((draft: any) => {
      draft.timeSignatureMap = [...draft.timeSignatureMap.filter((item: any) => item.tick !== marker.tick), marker].sort((a: any, b: any) => a.tick - b.tick);
      if (marker.tick === 0) draft.timeSignature = { numerator: marker.numerator, denominator: marker.denominator };
      return draft;
    });
    setRecordingMessage(t("{position} 박자를 {numerator}/{denominator}로 저장했습니다.", { position: timelinePositionLabel(marker.tick), numerator: marker.numerator, denominator: marker.denominator }));
  };
  const deleteTimelineMeter = () => {
    if (!timelineEditor || timelineEditor.tick === 0) return;
    commit((draft: any) => {
      draft.timeSignatureMap = draft.timeSignatureMap.filter((item: any) => item.tick !== timelineEditor.tick);
      return draft;
    });
    setRecordingMessage(t("{position} 박자 변경을 삭제했습니다.", { position: timelinePositionLabel(timelineEditor.tick) }));
  };
  const quantizeGridTicks = quantizationGridTicks(project.recording.quantize);
  const structuralTicks = new Set([
    ...timelineGrid.measures.map((measure: any) => measure.tick),
    ...timelineGrid.beats.map((beat: any) => beat.tick),
  ]);
  const quantizeLines = quantizeGridTicks
    ? Array.from({ length: Math.floor(pianoTimelineDuration / quantizeGridTicks) + 1 }, (_, index) => index * quantizeGridTicks)
      .filter((tick) => !structuralTicks.has(tick))
    : [];
  const seekPlayhead = (tick: number) => {
    clearPlayback();
    const nextTick = Math.max(0, Math.min(songDuration, tick));
    playheadRef.current = nextTick;
    setPlayhead(nextTick);
    window.requestAnimationFrame(() => {
      const roll = pianoRollRef.current;
      if (!roll) return;
      roll.scrollLeft = followTimelineScroll(
        roll.scrollLeft,
        roll.clientWidth,
        roll.scrollWidth,
        nextTick * pianoPixelsPerTick,
      );
    });
  };
  const changeTimelineZoom = (factor: number, anchor?: { tick: number; offset: number }) => {
    const roll = pianoRollRef.current;
    const current = timelineZoomRef.current;
    const next = clampPianoTimelineZoom(current * factor);
    if (next === current) return;
    if (roll) {
      const offset = Math.max(0, Math.min(roll.clientWidth, anchor?.offset ?? roll.clientWidth / 2));
      timelineZoomAnchorRef.current = anchor ?? {
        tick: (roll.scrollLeft + offset) / (PIANO_PIXELS_PER_TICK * current * fitTimelineScale),
        offset,
      };
    }
    timelineZoomRef.current = next;
    setTimelineZoom(next);
  };
  const visibleNotes = useMemo(() => displayTracks.flatMap((track: any, trackIndex: number) => {
    if (!project.tracks[trackIndex]?.pianoRollVisible) return [];
    return track.notes.map((note: any) => ({ ...note, trackIndex }));
  }), [displayTracks, project.tracks]);
  const visibleMidi = useMemo(
    () => [...visibleNotes.map((note: any) => note.midi), ...liveRecordingNotes.map((note) => note.midi)],
    [liveRecordingNotes, visibleNotes],
  );
  const minMidi = Math.min(12, ...visibleMidi);
  const maxMidi = Math.max(108, ...visibleMidi);
  const unscaledPianoHeight = (maxMidi - minMidi + 1) * PIANO_PITCH_ROW_HEIGHT;
  const fitPitchScale = pianoViewportHeight > 0
    ? Math.max(1, (pianoViewportHeight + 1) / unscaledPianoHeight)
    : 1;
  const minimumPitchZoom = pianoViewportHeight > 0
    ? Math.max(0.5, Math.min(3, (pianoViewportHeight + 1) / (unscaledPianoHeight * fitPitchScale)))
    : 0.5;
  const clampPianoPitchZoom = (value: number) => Math.max(minimumPitchZoom, Math.max(0.5, Math.min(3, value)));
  const pitchRenderZoom = pitchZoom * fitPitchScale;
  const pixelsPerPitch = PIANO_PITCH_ROW_HEIGHT * pitchRenderZoom;
  const pianoHeight = (maxMidi - minMidi + 1) * pixelsPerPitch;

  const pianoContentPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + event.currentTarget.scrollLeft,
      y: event.clientY - rect.top + event.currentTarget.scrollTop,
    };
  };

  const selectNotesInMarquee = (range: { startX: number; startY: number; endX: number; endY: number }, pointerType: string) => {
    const left = Math.min(range.startX, range.endX);
    const right = Math.max(range.startX, range.endX);
    const top = Math.min(range.startY, range.endY);
    const bottom = Math.max(range.startY, range.endY);
    const track = displayTracks[selectedTrackIndex];
    const selectedNotes = (track?.notes ?? []).filter((note: any) => {
      const noteLeft = tickToPianoX(note.tick);
      const noteRight = noteLeft + Math.max(4, tickToPianoX(note.duration));
      const noteTop = (maxMidi - note.midi) * pixelsPerPitch;
      const noteBottom = noteTop + Math.max(5, pixelsPerPitch - 1);
      return noteRight >= left && noteLeft <= right && noteBottom >= top && noteTop <= bottom;
    }).sort((a: any, b: any) => a.sourceStart - b.sourceStart);

    if (!selectedNotes.length) {
      setSourceSelection(null);
      return;
    }

    const start = selectedNotes[0].sourceStart;
    const end = Math.max(...selectedNotes.map((note: any) => note.sourceEnd));
    setSourceSelection({ trackId: selectedTrack.id, start, end });
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setSelectionRange(start, end);
      if (pointerType === "mouse") editor.focus({ preventScroll: true });
    });
  };

  const beginPianoSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".mml-change-marker, .mml-zoom-controls, .mml-note-select-toggle")) return;
    if ((event.target as HTMLElement).closest(".mml-note-block") && !noteSelectMode) return;
    if (event.pointerType === "touch" && !noteSelectMode) return;

    if (event.pointerType === "touch") {
      pianoTouchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pianoTouchPointersRef.current.size >= 2) {
        const points = [...pianoTouchPointersRef.current.values()];
        pianoTouchPanRef.current = {
          x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
          scrollLeft: event.currentTarget.scrollLeft,
          scrollTop: event.currentTarget.scrollTop,
        };
        pianoSelectionRef.current = null;
        setNoteMarquee(null);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    const point = pianoContentPoint(event);
    pianoSelectionRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      moved: false,
    };
    setNoteMarquee({ startX: point.x, startY: point.y, endX: point.x, endY: point.y });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const movePianoSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && pianoTouchPointersRef.current.has(event.pointerId)) {
      pianoTouchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pan = pianoTouchPanRef.current;
      if (pan && pianoTouchPointersRef.current.size >= 2) {
        const points = [...pianoTouchPointersRef.current.values()];
        const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        event.currentTarget.scrollLeft = pan.scrollLeft - (x - pan.x);
        event.currentTarget.scrollTop = pan.scrollTop - (y - pan.y);
        event.preventDefault();
        return;
      }
    }

    const selection = pianoSelectionRef.current;
    if (!selection || selection.pointerId !== event.pointerId) return;
    const point = pianoContentPoint(event);
    selection.endX = point.x;
    selection.endY = point.y;
    selection.moved ||= Math.hypot(point.x - selection.startX, point.y - selection.startY) >= 4;
    setNoteMarquee({ startX: selection.startX, startY: selection.startY, endX: point.x, endY: point.y });
    event.preventDefault();
  };

  const endPianoSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      pianoTouchPointersRef.current.delete(event.pointerId);
      if (pianoTouchPanRef.current) {
        if (pianoTouchPointersRef.current.size < 2) pianoTouchPanRef.current = null;
        pianoSelectionRef.current = null;
        setNoteMarquee(null);
        suppressPianoClickRef.current = true;
        window.setTimeout(() => { suppressPianoClickRef.current = false; }, 0);
        return;
      }
    }

    const selection = pianoSelectionRef.current;
    if (!selection || selection.pointerId !== event.pointerId) return;
    pianoSelectionRef.current = null;
    setNoteMarquee(null);
    if (selection.moved || noteSelectMode) {
      selectNotesInMarquee(selection, selection.pointerType);
      suppressPianoClickRef.current = true;
      window.setTimeout(() => { suppressPianoClickRef.current = false; }, 0);
    }
  };

  const changePitchZoom = (factor: number, anchor?: { midi: number; offset: number }) => {
    const roll = pianoRollRef.current;
    const current = pitchZoomRef.current;
    const next = clampPianoPitchZoom(current * factor);
    if (next === current) return;
    if (roll) {
      const offset = Math.max(0, Math.min(roll.clientHeight, anchor?.offset ?? roll.clientHeight / 2));
      pitchZoomAnchorRef.current = anchor ?? {
        midi: maxMidi + 0.5 - (roll.scrollTop + offset) / (PIANO_PITCH_ROW_HEIGHT * current * fitPitchScale),
        offset,
      };
    }
    pitchZoomRef.current = next;
    setPitchZoom(next);
  };

  const clearWheelPreviewStyle = () => {
    [pianoGridRef.current, pianoRulerRef.current, pianoPitchLabelsRef.current].forEach((element) => {
      if (!element) return;
      element.style.removeProperty("transform");
      element.style.removeProperty("transform-origin");
      element.style.removeProperty("will-change");
      element.style.removeProperty("width");
    });
    pianoRulerRef.current
      ?.querySelectorAll<HTMLElement>(".mml-measure-label, .mml-change-marker")
      .forEach((element) => element.style.removeProperty("transform"));
    pianoPitchLabelsRef.current
      ?.querySelectorAll<HTMLElement>(".mml-pitch-label")
      .forEach((element) => element.style.removeProperty("transform"));
  };

  useLayoutEffect(() => {
    if (!visible) return;
    const roll = pianoRollRef.current;
    if (!roll) return;
    const updateWidth = () => {
      const width = roll.clientWidth;
      const height = roll.clientHeight;
      setPianoViewportWidth((current) => Math.abs(current - width) < 0.5 ? current : width);
      setPianoViewportHeight((current) => Math.abs(current - height) < 0.5 ? current : height);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(roll);
    return () => observer.disconnect();
  }, [expanded, visible]);

  useLayoutEffect(() => {
    const current = timelineZoomRef.current;
    if (current >= minimumTimelineZoom) return;
    timelineZoomRef.current = minimumTimelineZoom;
    setTimelineZoom(minimumTimelineZoom);
  }, [minimumTimelineZoom]);

  useLayoutEffect(() => {
    const current = pitchZoomRef.current;
    if (current >= minimumPitchZoom) return;
    pitchZoomRef.current = minimumPitchZoom;
    setPitchZoom(minimumPitchZoom);
  }, [minimumPitchZoom]);

  const renderWheelZoomPreview = () => {
    const grid = pianoGridRef.current;
    const ruler = pianoRulerRef.current;
    const pitchLabels = pianoPitchLabelsRef.current;
    const roll = pianoRollRef.current;
    if (!grid || !ruler || !pitchLabels || !roll) return;
    const state = wheelZoomRef.current;
    const horizontal = state.timelineAnchor
      ? zoomPreviewTransform(
        state.timelineAnchor.tick * PIANO_PIXELS_PER_TICK,
        state.timelineBaseZoom * fitTimelineScale,
        state.timelineTargetZoom * fitTimelineScale,
      )
      : { origin: 0, scale: 1 };
    const vertical = state.pitchAnchor
      ? zoomPreviewTransform(
        (maxMidi - state.pitchAnchor.midi + 0.5) * PIANO_PITCH_ROW_HEIGHT,
        state.pitchBaseZoom * fitPitchScale,
        state.pitchTargetZoom * fitPitchScale,
      )
      : { origin: 0, scale: 1 };
    const nextScrollLeft = state.timelineAnchor
      ? anchoredScrollOffset(
        state.timelineAnchor.tick * PIANO_PIXELS_PER_TICK,
        state.timelineTargetZoom * fitTimelineScale,
        state.timelineAnchor.offset,
        roll.clientWidth,
        unscaledPianoWidth * state.timelineTargetZoom * fitTimelineScale,
      )
      : roll.scrollLeft;
    const nextScrollTop = state.pitchAnchor
      ? anchoredScrollOffset(
        (maxMidi - state.pitchAnchor.midi + 0.5) * PIANO_PITCH_ROW_HEIGHT,
        state.pitchTargetZoom * fitPitchScale,
        state.pitchAnchor.offset,
        roll.clientHeight,
        unscaledPianoHeight * state.pitchTargetZoom * fitPitchScale,
      )
      : roll.scrollTop;
    const translateX = roll.scrollLeft - nextScrollLeft;
    const translateY = roll.scrollTop - nextScrollTop;
    grid.style.willChange = "transform";
    grid.style.transformOrigin = "0 0";
    grid.style.transform = `translate(${translateX}px, ${translateY}px) scale(${horizontal.scale}, ${vertical.scale})`;

    // Keep ruler labels and controls at their natural size. Only move their positions.
    ruler.style.willChange = "transform";
    ruler.style.transformOrigin = "0 0";
    ruler.style.transform = `translateX(${translateX}px)`;
    ruler.style.width = `${unscaledPianoWidth * state.timelineTargetZoom * fitTimelineScale}px`;
    ruler.querySelectorAll<HTMLElement>(".mml-measure-label, .mml-change-marker").forEach((element) => {
      const tick = Number(element.dataset.tick) || 0;
      const minimum = element.classList.contains("mml-change-marker") ? 4 : 0;
      const offset = zoomPreviewPositionOffset(
        tick * PIANO_PIXELS_PER_TICK,
        state.timelineBaseZoom * fitTimelineScale,
        state.timelineTargetZoom * fitTimelineScale,
        minimum,
      );
      element.style.transform = offset ? `translateX(${offset}px)` : "none";
    });

    // Keep pitch text at its natural size. Only move each label to its preview row.
    pitchLabels.style.willChange = "transform";
    pitchLabels.style.transformOrigin = "0 0";
    pitchLabels.style.transform = `translateY(${translateY}px)`;
    pitchLabels.querySelectorAll<HTMLElement>(".mml-pitch-label").forEach((element) => {
      const currentTop = Number.parseFloat(element.style.top) || 0;
      element.style.transform = `translateY(${currentTop * (vertical.scale - 1)}px)`;
      element.style.height = `${pixelsPerPitch * vertical.scale}px`;
    });
  };

  const commitWheelZoom = () => {
    const state = wheelZoomRef.current;
    state.commitTimer = null;
    const timelineAnchor = state.timelineAnchor;
    const pitchAnchor = state.pitchAnchor;
    const nextTimelineZoom = state.timelineTargetZoom;
    const nextPitchZoom = state.pitchTargetZoom;
    const timelineChanged = Boolean(timelineAnchor && nextTimelineZoom !== timelineZoomRef.current);
    const pitchChanged = Boolean(pitchAnchor && nextPitchZoom !== pitchZoomRef.current);
    if (timelineAnchor) {
      timelineZoomAnchorRef.current = timelineAnchor;
      timelineZoomRef.current = nextTimelineZoom;
      setTimelineZoom(nextTimelineZoom);
    }
    if (pitchAnchor) {
      pitchZoomAnchorRef.current = pitchAnchor;
      pitchZoomRef.current = nextPitchZoom;
      setPitchZoom(nextPitchZoom);
    }
    state.timelineAnchor = null;
    state.pitchAnchor = null;
    state.timelineBaseZoom = nextTimelineZoom;
    state.pitchBaseZoom = nextPitchZoom;
    if (!timelineChanged && !pitchChanged) clearWheelPreviewStyle();
  };

  useLayoutEffect(() => {
    timelineZoomRef.current = timelineZoom;
    const anchor = timelineZoomAnchorRef.current;
    const roll = pianoRollRef.current;
    if (!anchor || !roll) return;
    roll.scrollLeft = anchoredScrollOffset(
      anchor.tick * PIANO_PIXELS_PER_TICK,
      timelineZoom * fitTimelineScale,
      anchor.offset,
      roll.clientWidth,
      roll.scrollWidth,
    );
    timelineZoomAnchorRef.current = null;
    clearWheelPreviewStyle();
  }, [fitTimelineScale, timelineZoom]);

  useLayoutEffect(() => {
    pitchZoomRef.current = pitchZoom;
    const anchor = pitchZoomAnchorRef.current;
    const roll = pianoRollRef.current;
    if (!anchor || !roll) return;
    roll.scrollTop = anchoredScrollOffset(
      (maxMidi - anchor.midi + 0.5) * PIANO_PITCH_ROW_HEIGHT,
      pitchZoom * fitPitchScale,
      anchor.offset,
      roll.clientHeight,
      roll.scrollHeight,
    );
    pitchZoomAnchorRef.current = null;
    clearWheelPreviewStyle();
  }, [fitPitchScale, maxMidi, pitchZoom]);

  const flushWheelZoom = () => {
    const state = wheelZoomRef.current;
    state.frame = 0;
    const timelineSteps = state.timelineSteps;
    const pitchSteps = state.pitchSteps;
    state.timelineSteps = 0;
    state.pitchSteps = 0;
    if (timelineSteps) {
      state.timelineTargetZoom = clampPianoTimelineZoom(state.timelineTargetZoom * Math.exp(-timelineSteps * 0.045));
    }
    if (pitchSteps) {
      state.pitchTargetZoom = clampPianoPitchZoom(state.pitchTargetZoom * Math.exp(-pitchSteps * 0.045));
    }
    renderWheelZoomPreview();
    if (state.commitTimer !== null) window.clearTimeout(state.commitTimer);
    state.commitTimer = window.setTimeout(commitWheelZoom, 90);
  };

  const zoomTimelineWithWheel = (event: WheelEvent) => {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const roll = pianoRollRef.current;
    if (!roll) return;
    const delta = event.deltaY || event.deltaX;
    const steps = normalizedWheelSteps(delta, event.deltaMode, roll.clientHeight);
    if (!steps) return;
    const rect = roll.getBoundingClientRect();
    const state = wheelZoomRef.current;
    const x = Math.max(0, Math.min(roll.clientWidth, event.clientX - rect.left));
    const y = Math.max(0, Math.min(roll.clientHeight, event.clientY - rect.top));
    state.activeUntil = performance.now() + 180;
    if (event.shiftKey) {
      if (!state.pitchAnchor) {
        state.pitchBaseZoom = pitchZoomRef.current;
        state.pitchTargetZoom = pitchZoomRef.current;
        state.pitchAnchor = {
          midi: maxMidi + 0.5 - (roll.scrollTop + y) / (PIANO_PITCH_ROW_HEIGHT * pitchZoomRef.current * fitPitchScale),
          offset: y,
        };
      }
      state.pitchSteps = Math.max(-6, Math.min(6, state.pitchSteps + steps));
    } else {
      if (!state.timelineAnchor) {
        state.timelineBaseZoom = timelineZoomRef.current;
        state.timelineTargetZoom = timelineZoomRef.current;
        state.timelineAnchor = {
          tick: (roll.scrollLeft + x) / (PIANO_PIXELS_PER_TICK * timelineZoomRef.current * fitTimelineScale),
          offset: x,
        };
      }
      state.timelineSteps = Math.max(-6, Math.min(6, state.timelineSteps + steps));
    }
    if (!state.frame) state.frame = window.requestAnimationFrame(flushWheelZoom);
  };
  pianoRollWheelHandlerRef.current = zoomTimelineWithWheel;

  useEffect(() => {
    const roll = pianoRollRef.current;
    if (!roll) return;
    const handleWheel = (event: WheelEvent) => pianoRollWheelHandlerRef.current(event);
    roll.addEventListener("wheel", handleWheel, { passive: false });
    return () => roll.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (!hydrated || pianoRollCenteredRef.current) return;
    const roll = pianoRollRef.current;
    if (!roll) return;
    const lowestVisible = visibleMidi.length ? Math.min(...visibleMidi) : 60;
    const highestVisible = visibleMidi.length ? Math.max(...visibleMidi) : 60;
    const focusMidi = Math.max(minMidi, Math.min(maxMidi, (lowestVisible + highestVisible) / 2));
    roll.scrollTop = Math.max(0, (maxMidi - focusMidi + 0.5) * pixelsPerPitch - roll.clientHeight / 2);
    pianoRollCenteredRef.current = true;
  }, [hydrated, maxMidi, minMidi, pixelsPerPitch, visibleMidi]);

  useLayoutEffect(() => {
    if (!playing && recordState !== "recording") return;
    if (performance.now() < wheelZoomRef.current.activeUntil) return;
    const roll = pianoRollRef.current;
    if (!roll) return;
    roll.scrollLeft = followTimelineScroll(
      roll.scrollLeft,
      roll.clientWidth,
      roll.scrollWidth,
      playheadX,
    );
  }, [playheadX, playing, recordState]);

  const timelineContext = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const rawTick = Math.max(0, Math.min(pianoTimelineDuration, Math.round((event.clientX - rect.left + event.currentTarget.scrollLeft) / pianoPixelsPerTick)));
    const tick = snapTickToGrid(rawTick, project.recording.quantize);
    const workArea = event.currentTarget.parentElement;
    const workRect = workArea?.getBoundingClientRect();
    const anchor = workArea && workRect && workArea.clientWidth > 680
      ? { x: event.clientX - workRect.left + 10, y: event.clientY - workRect.top + 10 }
      : undefined;
    openTimelineEditor(tick, anchor);
  };
  const timelineTempoTrack = timelineEditor
    ? project.tracks.find((track: any) => track.id === timelineEditor.tempoTrackId)
    : null;
  const closeStudio = () => {
    setSettingsView(false);
    setTrackSettingsView(false);
    setTrackSettingsAnchor(null);
    setBatchSettingsView(false);
    setBatchSettingsAnchor(null);
    setFileMenuView(false);
    setImportPayload(null);
    setDurationMenu(null);
    setTimelineEditor(null);
    onClose();
  };

  return (
    <section className={`mml-studio ${visible ? "" : "is-hidden"}`} aria-label={t("MML 편집과 녹음")} aria-hidden={!visible}>
      <header className="mml-studio-header">
        <div className="mml-project-title">
          <span>{brandName} MML</span>
          <input aria-label={t("프로젝트 제목")} placeholder={t("프로젝트 제목")} value={project.title} onChange={(event) => commit((draft: any) => ({ ...draft, title: event.target.value }))} />
        </div>
        <div className="mml-record-feedback">
          <div className={`mml-record-state is-${recordState}`}>
            <i />
            <strong>{recordState === "idle" ? `${t(project.recording.mode === "realtime" ? "실시간" : "이어붙이기")} · ${recordTempo} BPM` : recordingMessage}</strong>
          </div>
          <div
            className={`mml-beat-visual ${metronomeVisual.preparing ? "is-preparing" : ""}`}
            data-pulse={metronomeVisual.pulse}
            aria-label={t(metronomeVisual.preparing ? "녹음 준비 박자" : "메트로놈 박자")}
          >
            <span>{t(metronomeVisual.preparing ? "준비" : "박자")}</span>
            <div>
              {Array.from({ length: Math.max(1, metronomeVisual.count) }, (_, index) => (
                <i className={metronomeVisual.beat === index ? "is-active" : ""} key={index} />
              ))}
            </div>
          </div>
        </div>
        <button type="button" className="mml-expand" onClick={() => onExpandedChange(!expanded)} aria-label={t(expanded ? "작곡창 축소" : "작곡창 전체화면")} title={t(expanded ? "작곡창 축소" : "작곡창 전체화면")}>{expanded ? <Minimize2 className="mml-header-icon" aria-hidden="true" /> : <Maximize2 className="mml-header-icon" aria-hidden="true" />}</button>
        <button type="button" className="mml-close" onClick={closeStudio} aria-label={t("MML 닫기")} disabled={recordState !== "idle"}><X className="mml-header-icon" aria-hidden="true" /></button>
      </header>

      <div className="mml-transport" aria-label={t("MML 재생과 녹음")}>
        <div className="mml-transport-primary">
          <button type="button" className="is-primary" aria-label={t(playing ? "일시정지" : "재생")} title={t(playing ? "일시정지" : "재생")} onClick={() => (playing ? clearPlayback() : startPlayback())} disabled={Boolean(parseError)}>{playing ? <Pause className="mml-tool-icon" aria-hidden="true" /> : <Play className="mml-tool-icon" aria-hidden="true" />}<span>{t(playing ? "일시정지" : "재생")}</span><kbd>{shortcutLabel(recordingShortcuts.play)}</kbd></button>
          <button type="button" onClick={() => {
            if (recordState !== "idle") finishRecording();
            else {
              clearPlayback();
              playheadRef.current = 0;
              setPlayhead(0);
            }
          }} aria-label={t("정지")} title={t("정지")}><Square className="mml-tool-icon" aria-hidden="true" /><span>{t("정지")}</span><kbd>{shortcutLabel(recordingShortcuts.stop)}</kbd></button>
          <button type="button" className={`is-record ${recordState !== "idle" ? "is-active" : ""}`} aria-label={t(recordState === "idle" ? "녹음" : "끝내기")} title={t(recordState === "idle" ? "녹음" : "끝내기")} onClick={() => recordState === "idle" ? beginRecording() : finishRecording()} disabled={recordState === "idle" && Boolean(parseError)}><Circle className="mml-tool-icon mml-record-icon" aria-hidden="true" /><span>{t(recordState === "idle" ? "녹음" : "끝내기")}</span><kbd>{shortcutLabel(recordingShortcuts.record)}</kbd></button>
        </div>
        <nav className="mml-transport-navigation" aria-label={t("재생 위치 이동")}>
          <button type="button" aria-label={t("맨앞으로 이동")} title={t("맨앞으로 이동")} disabled={recordState !== "idle"} onClick={() => seekPlayhead(0)}><SkipBack className="mml-tool-icon" aria-hidden="true" /></button>
          <button type="button" aria-label={t("한 마디 이전")} title={t("한 마디 이전")} disabled={recordState !== "idle"} onClick={() => seekPlayhead(adjacentMeasureTick(timelineGrid.measures, playheadRef.current, -1, songDuration))}><ChevronLeft className="mml-tool-icon" aria-hidden="true" /><span>{t("1마디")}</span></button>
          <button type="button" aria-label={t("한 마디 다음")} title={t("한 마디 다음")} disabled={recordState !== "idle"} onClick={() => seekPlayhead(adjacentMeasureTick(timelineGrid.measures, playheadRef.current, 1, songDuration))}><span>{t("1마디")}</span><ChevronRight className="mml-tool-icon" aria-hidden="true" /></button>
          <button type="button" aria-label={t("맨뒤로 이동")} title={t("맨뒤로 이동")} disabled={recordState !== "idle"} onClick={() => seekPlayhead(songDuration)}><SkipForward className="mml-tool-icon" aria-hidden="true" /></button>
        </nav>
        <div className="mml-transport-toggles">
          <button type="button" className={project.recording.metronome ? "is-active" : ""} aria-label={t("메트로놈")} title={t("메트로놈")} aria-pressed={project.recording.metronome} onClick={toggleMetronome}><Music2 className="mml-tool-icon" aria-hidden="true" /><span>{t("메트로놈")}</span></button>
          <button type="button" className={project.view.loop ? "is-active" : ""} aria-label={t("반복")} title={t("반복")} aria-pressed={project.view.loop} onClick={() => commit((draft: any) => { draft.view.loop = !draft.view.loop; return draft; })}><Repeat2 className="mml-tool-icon" aria-hidden="true" /><span>{t("반복")}</span></button>
        </div>
        <div className="mml-transport-tools">
          <button type="button" onClick={undo} disabled={!past.length || recordState !== "idle"} aria-label={t("실행 취소")} title={t("실행 취소")}><Undo2 className="mml-tool-icon" aria-hidden="true" /></button>
          <button type="button" onClick={redo} disabled={!future.length || recordState !== "idle"} aria-label={t("다시 실행")} title={t("다시 실행")}><Redo2 className="mml-tool-icon" aria-hidden="true" /></button>
          <button type="button" className={settingsView ? "is-active" : ""} aria-label={t("녹음 설정")} disabled={recordState !== "idle"} onClick={() => { setSettingsView((value) => !value); setTrackSettingsView(false); setFileMenuView(false); }}><Settings className="mml-tool-icon" aria-hidden="true" /><span>{t("녹음 설정")}</span></button>
          <button type="button" className={fileMenuView ? "is-active" : ""} aria-label={t("파일 메뉴")} disabled={recordState !== "idle"} onClick={() => { setFileMenuView((value) => !value); setSettingsView(false); setTrackSettingsView(false); }}><Ellipsis className="mml-tool-icon" aria-hidden="true" /><span>{t("파일")}</span></button>
        </div>
        <input ref={fileInputRef} type="file" accept=".mml,.mmi,.nyangmml,.mid,.midi,audio/midi,audio/x-midi,text/plain,application/json" hidden onChange={importFile} />
      </div>

      {fileMenuView && (
        <div className="mml-action-menu" role="dialog" aria-label={t("MML 파일 메뉴")}>
          <div className="mml-action-menu-head"><strong>{t("파일")}</strong><button type="button" className="mml-panel-close" onClick={() => setFileMenuView(false)} aria-label={t("파일 메뉴 닫기")}><X aria-hidden="true" /></button></div>
          <div className="mml-action-menu-list">
            <button type="button" onClick={resetProject}><b><Plus aria-hidden="true" /></b><span><strong>{t("새 프로젝트")}</strong><small>{t("현재 작업을 비우고 새로 시작")}</small></span></button>
            <button type="button" onClick={() => fileInputRef.current?.click()}><b><Upload aria-hidden="true" /></b><span><strong>{t("불러오기")}</strong><small>MML · 3MLE · MMI · {brandName} · MIDI</small></span></button>
            <button type="button" onClick={() => { exportMidi(); setFileMenuView(false); }}><b><FileMusic aria-hidden="true" /></b><span><strong>{t("MIDI 내보내기")}</strong><small>{t("표준 MIDI 파일로 저장")}</small></span></button>
            <button type="button" onClick={() => { exportMml(); setFileMenuView(false); }}><b>M</b><span><strong>{t("MML 내보내기")}</strong><small>{t("주석을 제외한 호환 코드")}</small></span></button>
            <button type="button" onClick={() => { void writeAppClipboard(combineTracks(project.tracks.map((track: any) => track.sourceText), { removeComments: true })); setFileMenuView(false); }}><b><ClipboardCopy aria-hidden="true" /></b><span><strong>{t("전체 MML 복사")}</strong><small>{t("모든 트랙을 클립보드로")}</small></span></button>
            <button type="button" onClick={() => { exportProject(); setFileMenuView(false); }}><b>{brandName.slice(0, 1)}</b><span><strong>{t("프로젝트 저장")}</strong><small>{t("설정과 트랙을 함께 보관")}</small></span></button>
          </div>
        </div>
      )}

      {importPayload && (
        <div className="mml-import-dialog" role="dialog" aria-modal="true" aria-label={t("MML 불러오기 방식 선택")}>
          <div className="mml-import-card">
            <div className="mml-action-menu-head"><strong>{t("MML을 어떻게 넣을까요?")}</strong><button type="button" className="mml-panel-close" onClick={() => setImportPayload(null)} aria-label={t("MML 불러오기 취소")}><X aria-hidden="true" /></button></div>
            <button type="button" onClick={() => applyImport("replace")}><strong>{t("전체 교체")}</strong><small>{t("현재 트랙을 지우고 불러온 곡으로 교체")}</small></button>
            <button type="button" onClick={() => applyImport("append")}><strong>{t("곡 뒤에 이어 붙이기")}</strong><small>{t("각 트랙의 마지막에 추가")}</small></button>
            <button type="button" onClick={() => applyImport("tracks")}><strong>{t("새 트랙으로 추가")}</strong><small>{t("현재 곡은 유지하고 트랙만 추가")}</small></button>
            <button type="button" onClick={() => applyImport("selected")}><strong>{t("선택 트랙만 교체")}</strong><small>{t("첫 번째 불러온 트랙으로 교체")}</small></button>
          </div>
        </div>
      )}

      {settingsView && (
        <div className="mml-quick-settings" role="dialog" aria-label={t("MML 세부 설정")}>
          <div className="mml-quick-settings-head"><span><strong>{t("녹음 설정")}</strong><small>{t("입력 방식과 박자 보정")}</small></span><button type="button" className="mml-panel-close" onClick={() => setSettingsView(false)} aria-label={t("녹음 설정 닫기")}><X aria-hidden="true" /></button></div>
          <label>{t("녹음 방식")}<select value={project.recording.mode} onChange={(event) => commit((draft: any) => { draft.recording.mode = event.target.value; return draft; })}><option value="realtime">{t("실시간")}</option><option value="append">{t("이어붙이기")}</option></select></label>
          <label>{t("녹음 시작 위치")}<select value={project.recording.startPosition} onChange={(event) => commit((draft: any) => { draft.recording.startPosition = event.target.value; return draft; })}><option value="playhead">{t("현재 재생 위치")}</option><option value="beginning">{t("처음부터")}</option><option value="empty">{t("연결 트랙의 빈 끝부분")}</option></select></label>
          <label>{t("편집 방식")}<select value={project.recording.editMode} onChange={(event) => commit((draft: any) => { draft.recording.editMode = event.target.value; return draft; })}><option value="overwrite">{t("수정")}</option><option value="insert">{t("삽입")}</option></select></label>
          {project.recording.editMode === "insert" && <label>{t("삽입 범위")}<select value={project.recording.insertScope} onChange={(event) => commit((draft: any) => { draft.recording.insertScope = event.target.value; return draft; })}><option value="all">{t("전체 트랙 밀기")}</option><option value="used">{t("사용 트랙만 밀기")}</option></select></label>}
          <label>{t("박자 보정")}<select value={project.recording.quantize} onChange={(event) => commit((draft: any) => { draft.recording.quantize = event.target.value; return draft; })}>{["1/1", "1/2", "1/4", "1/8", "1/16", "1/32", "auto", "off"].map((value) => <option value={value} key={value}>{value === "off" ? t("보정 안 함") : value === "auto" ? t("자동 리듬 인식") : value}</option>)}</select></label>
          <label>{t("음 배정")}<select value={project.recording.pitchPriority} onChange={(event) => commit((draft: any) => { draft.recording.pitchPriority = event.target.value; return draft; })}><option value="high">{t("높은 음 우선")}</option><option value="low">{t("낮은 음 우선")}</option></select></label>
          <label>{t("기록 v")}<input type="number" min="0" max="15" value={selectedTrack.recordVelocity} onChange={(event) => updateTrack(selectedTrack.id, { recordVelocity: Math.max(0, Math.min(15, Number(event.target.value))) })} /></label>
          <label>{t("트랙 템포")}<input key={`tempo-${recordTempo}`} type="number" min="1" defaultValue={recordTempo} onBlur={(event) => updateMasterTempo(Number(event.target.value))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
          <label className="mml-meter-setting">{t("박자표")}<div className="mml-meter-controls"><select aria-label={t("박자표 선택")} value={["2/4", "3/4", "4/4", "6/8", "9/8", "12/8"].includes(`${project.timeSignature.numerator}/${project.timeSignature.denominator}`) ? `${project.timeSignature.numerator}/${project.timeSignature.denominator}` : "custom"} onChange={(event) => {
            if (event.target.value === "custom") return;
            const [numerator, denominator] = event.target.value.split("/").map(Number);
            commit((draft: any) => { draft.timeSignature = { numerator, denominator }; draft.timeSignatureMap = [{ tick: 0, numerator, denominator }, ...draft.timeSignatureMap.filter((item: any) => item.tick !== 0)]; return draft; });
          }}>{["2/4", "3/4", "4/4", "6/8", "9/8", "12/8"].map((value) => <option value={value} key={value}>{value}</option>)}<option value="custom">{t("직접 입력")}</option></select><span className="mml-meter-fraction"><input aria-label={t("박자 분자")} type="number" min="1" value={project.timeSignature.numerator} onChange={(event) => commit((draft: any) => { draft.timeSignature.numerator = Math.max(1, Number(event.target.value)); draft.timeSignatureMap = [{ tick: 0, ...draft.timeSignature }, ...draft.timeSignatureMap.filter((item: any) => item.tick !== 0)]; return draft; })} /><i>/</i><input aria-label={t("박자 분모")} type="number" min="1" value={project.timeSignature.denominator} onChange={(event) => commit((draft: any) => { draft.timeSignature.denominator = Math.max(1, Number(event.target.value)); draft.timeSignatureMap = [{ tick: 0, ...draft.timeSignature }, ...draft.timeSignatureMap.filter((item: any) => item.tick !== 0)]; return draft; })} /></span></div></label>
          {project.recording.mode === "realtime" && <label>{t("카운트인")}<select value={project.recording.countIn} onChange={(event) => commit((draft: any) => { draft.recording.countIn = Number(event.target.value); return draft; })}><option value="0">{t("없음")}</option><option value="1">{t("1마디")}</option><option value="2">{t("2마디")}</option></select></label>}
          <label>{t("메트로놈 음량")}<RangeControl ariaLabel={t("메트로놈 음량")} min={0} max={1} step={0.05} value={project.recording.metronomeVolume} onValueChange={(metronomeVolume) => commit((draft: any) => { draft.recording.metronomeVolume = metronomeVolume; return draft; })} /></label>
          {project.recording.mode === "append" && <label>{t("쉼표 키")}<input value={project.recording.restKey.replace(/^Key/, "")} readOnly onKeyDown={(event) => { event.preventDefault(); commit((draft: any) => { draft.recording.restKey = event.code; return draft; }); }} /></label>}
          {(["play", "record", "stop"] as const).map((action) => <label key={action}>{t(action === "play" ? "재생 키" : action === "record" ? "녹음 키" : "정지 키")}<input value={shortcutLabel(recordingShortcuts[action])} readOnly onKeyDown={(event) => captureShortcut(action, event)} /></label>)}
          <div className="mml-loop-setting" role="group" aria-label={t("반복 구간")}>
            <div className="mml-loop-controls">
              <label>{t("반복 시작 마디")}<input aria-label={t("반복 시작 마디")} type="number" min="1" max={songMeasures.length} value={loopStartMeasure} onChange={(event) => commit((draft: any) => { const measure = Math.max(1, Math.min(songMeasures.length, Number(event.target.value) || 1)); draft.view.loopStart = songMeasures[measure - 1]?.tick ?? 0; if (draft.view.loopEnd > 0 && draft.view.loopEnd <= draft.view.loopStart) draft.view.loopEnd = songMeasures[measure]?.tick ?? 0; return draft; })} /></label>
              <label>{t("반복 끝 마디")}<input aria-label={t("반복 끝 마디")} type="number" min={loopStartMeasure} max={songMeasures.length} value={loopEndMeasure} onChange={(event) => commit((draft: any) => { const measure = Math.max(loopStartMeasure, Math.min(songMeasures.length, Number(event.target.value) || songMeasures.length)); draft.view.loopEnd = measure >= songMeasures.length ? 0 : songMeasures[measure]?.tick ?? 0; return draft; })} /></label>
            </div>
          </div>
          <button type="button" onClick={() => window.alert(parseError ? parseError.message : tempoConflict || t("{brand}에서 재생할 수 있는 MML입니다.", { brand: brandName }))}>{t("호환성 검사")}</button>
        </div>
      )}

      {trackSettingsView && (
        <div
          ref={trackSettingsRef}
          className="mml-track-settings"
          role="dialog"
          aria-label={t("{name} 설정", { name: selectedTrack.name })}
          style={trackSettingsAnchor ? { left: trackSettingsAnchor.x, top: trackSettingsAnchor.y, right: "auto", transform: "none" } : undefined}
        >
          <div className="mml-quick-settings-head"><span><strong>{t("트랙 설정")}</strong><small>{t("선택한 트랙의 녹음·재생 속성")}</small></span><button type="button" className="mml-panel-close" onClick={() => { setTrackSettingsView(false); setTrackSettingsAnchor(null); }} aria-label={t("트랙 설정 닫기")}><X aria-hidden="true" /></button></div>
          <label className="mml-track-name-field">{t("이름")}<input value={selectedTrack.name} onChange={(event) => updateTrack(selectedTrack.id, { name: event.target.value })} /></label>
          <label>{t("색상")}<input type="color" value={selectedTrack.color} onChange={(event) => updateTrack(selectedTrack.id, { color: event.target.value })} /></label>
          <label>{t("음색")}<select value={selectedTrack.themeId} onChange={(event) => changeTrackThemes([selectedTrack.id], event.target.value)}>{themes.map((theme) => <option value={theme.id} key={theme.id}>{theme.name}</option>)}</select></label>
          <label>{t("기록 음량")}<input type="number" min="0" max="15" value={selectedTrack.recordVelocity} onChange={(event) => updateTrack(selectedTrack.id, { recordVelocity: Math.max(0, Math.min(15, Number(event.target.value))) })} /></label>
          <label className="mml-track-volume-field">{t("재생 음량")}<RangeControl ariaLabel={t("{name} 재생 음량", { name: selectedTrack.name })} min={0} max={1} step={0.01} value={selectedTrack.mixerVolume} onValueChange={(mixerVolume) => updateTrack(selectedTrack.id, { mixerVolume })} /></label>
          <div className="mml-track-transpose-field">
            <strong>{t("이조")}</strong>
            <div>
              <button type="button" aria-label={t("한 옥타브 내림")} title={t("한 옥타브 내림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts([selectedTrack.id], -12)}>−12</button>
              <button type="button" aria-label={t("반음 내림")} title={t("반음 내림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts([selectedTrack.id], -1)}>−1</button>
              <button type="button" aria-label={t("반음 올림")} title={t("반음 올림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts([selectedTrack.id], 1)}>+1</button>
              <button type="button" aria-label={t("한 옥타브 올림")} title={t("한 옥타브 올림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts([selectedTrack.id], 12)}>+12</button>
            </div>
          </div>
          <button type="button" className="mml-delete-track" onClick={() => { removeTrack(selectedTrack.id); setTrackSettingsView(false); setTrackSettingsAnchor(null); }} disabled={project.tracks.length <= 1}>{t("이 트랙 삭제")}</button>
        </div>
      )}

      {batchSettingsView && batchSelectedTracks.length > 0 && (
        <div
          ref={batchSettingsRef}
          className="mml-track-settings mml-batch-settings"
          role="dialog"
          aria-label={t("선택 트랙 일괄 설정")}
          style={batchSettingsAnchor ? { left: batchSettingsAnchor.x, top: batchSettingsAnchor.y, right: "auto", transform: "none" } : undefined}
        >
          <div className="mml-quick-settings-head">
            <span><strong>{t("선택 트랙 일괄 설정")}</strong><small>{t("{count}개 트랙", { count: batchSelectedTracks.length })}</small></span>
            <button type="button" className="mml-panel-close" onClick={() => { setBatchSettingsView(false); setBatchSettingsAnchor(null); }} aria-label={t("일괄 설정 닫기")}><X aria-hidden="true" /></button>
          </div>
          <div className="mml-batch-settings-body">
            <label>{t("음색")}<select value={batchThemeId} onChange={(event) => { if (event.target.value) changeTrackThemes(batchTrackIds, event.target.value); }}><option value="">{t(batchThemeId ? "음색 선택" : "서로 다른 음색")}</option>{themes.map((theme) => <option value={theme.id} key={theme.id}>{theme.name}</option>)}</select></label>
            <label>{t("기록 음량")}<input type="number" min="0" max="15" value={batchRecordVelocity} placeholder={t("혼합")} onChange={(event) => { if (event.target.value !== "") updateTracks(batchTrackIds, { recordVelocity: Math.max(0, Math.min(15, Number(event.target.value))) }); }} /></label>
            <label className="mml-track-volume-field">{t("재생 음량")}<RangeControl ariaLabel={t("선택 트랙 재생 음량")} min={0} max={1} step={0.01} value={batchMixerVolume} onValueChange={(mixerVolume) => updateTracks(batchTrackIds, { mixerVolume })} /></label>
          </div>
          <div className="mml-track-transpose-field">
            <strong>{t("이조")}</strong>
            <div>
              <button type="button" aria-label={t("선택 트랙 한 옥타브 내림")} title={t("한 옥타브 내림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts(batchTrackIds, -12)}>−12</button>
              <button type="button" aria-label={t("선택 트랙 반음 내림")} title={t("반음 내림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts(batchTrackIds, -1)}>−1</button>
              <button type="button" aria-label={t("선택 트랙 반음 올림")} title={t("반음 올림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts(batchTrackIds, 1)}>+1</button>
              <button type="button" aria-label={t("선택 트랙 한 옥타브 올림")} title={t("한 옥타브 올림")} disabled={recordState !== "idle"} onClick={() => transposeTrackTexts(batchTrackIds, 12)}>+12</button>
            </div>
          </div>
        </div>
      )}

      {durationMenu && (
        <div className="mml-duration-menu" role="menu" aria-label={t("선택 편집")} style={{ left: durationMenu.x, top: durationMenu.y }} onContextMenu={(event) => event.preventDefault()}>
          <header><strong>{t("선택 편집")}</strong><button type="button" className="mml-panel-close" onClick={() => setDurationMenu(null)} aria-label={t("선택 편집 닫기")}><X aria-hidden="true" /></button></header>
          <b className="mml-selection-section-title">{t("음가")}</b>
          <div className="mml-duration-grid">
            {[0, 1].flatMap((dots) => MML_NOTE_LENGTHS.map((length) => (
              <button type="button" role="menuitem" onClick={() => setSelectionDuration(length, dots)} key={`${length}-${dots}`}>
                <b>{length}{dots ? "." : ""}</b><span>{t(dots ? "점{length}분음표" : "{length}분음표", { length })}</span>
              </button>
            )))}
          </div>
          <small><kbd>Alt</kbd>+<kbd>,</kbd> {t("길게")} · <kbd>Alt</kbd>+<kbd>.</kbd> {t("짧게")}</small>
          <div className="mml-selection-transpose">
            <b className="mml-selection-section-title">{t("이조")}</b>
            <div>
              <button type="button" role="menuitem" onClick={() => transposeSelection(-12)} disabled={recordState !== "idle"} aria-label={t("선택 영역 한 옥타브 내림")}>−12</button>
              <button type="button" role="menuitem" onClick={() => transposeSelection(-1)} disabled={recordState !== "idle"} aria-label={t("선택 영역 반음 내림")}>−1</button>
              <button type="button" role="menuitem" onClick={() => transposeSelection(1)} disabled={recordState !== "idle"} aria-label={t("선택 영역 반음 올림")}>+1</button>
              <button type="button" role="menuitem" onClick={() => transposeSelection(12)} disabled={recordState !== "idle"} aria-label={t("선택 영역 한 옥타브 올림")}>+12</button>
            </div>
          </div>
        </div>
      )}

      <div className={`mml-main-grid ${mobileTrackListCollapsed ? "is-track-list-collapsed" : ""}`}>
        <aside
          className={`mml-track-list ${mobileTrackListCollapsed ? "is-mobile-collapsed" : ""}`}
          onPointerDown={beginTrackDrag}
          onPointerMove={moveTrackDrag}
          onPointerUp={endTrackDrag}
          onPointerCancel={endTrackDrag}
          onWheel={scrollTrackListWithWheel}
          onClickCapture={(event) => {
            if (!suppressTrackClickRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressTrackClickRef.current = false;
          }}
        >
          <div className={`mml-track-list-title ${batchSelectedTracks.length > 0 ? "has-selection" : ""}`}>
            <label className="mml-track-select-all">
              <input
                type="checkbox"
                checked={batchSelectedTracks.length === project.tracks.length && project.tracks.length > 0}
                ref={(input) => {
                  if (input) input.indeterminate = batchSelectedTracks.length > 0 && batchSelectedTracks.length < project.tracks.length;
                }}
                onChange={toggleAllBatchTracks}
                aria-label={batchSelectedTracks.length > 0 ? t("{count}개 트랙 선택 해제", { count: batchSelectedTracks.length }) : t("전체 트랙 선택")}
              />
              <span className="mml-track-select-label">
                <span className="mml-track-select-label-wide">{batchSelectedTracks.length > 0 ? t("{count}개 선택됨", { count: batchSelectedTracks.length }) : t("전체 선택")}</span>
                <span className="mml-track-select-label-compact">{batchSelectedTracks.length > 0 ? t("{count}개", { count: batchSelectedTracks.length }) : t("전체 선택")}</span>
              </span>
            </label>
            {batchSelectedTracks.length > 0 && <button type="button" className="mml-batch-open" aria-label={t("일괄 설정")} onClick={openBatchSettings}>{t("설정")}</button>}
          </div>
          {project.tracks.map((track: any, index: number) => (
            <div
              className={`mml-track-card ${track.id === selectedTrack.id ? "is-selected" : ""} ${batchTrackIds.includes(track.id) ? "is-batch-selected" : ""} ${trackReorder?.trackId === track.id ? "is-reordering" : ""} ${trackReorder?.targetId === track.id ? `is-drop-${trackReorder?.placement}` : ""}`}
              style={{ "--track-color": track.color } as CSSProperties}
              data-track-id={track.id}
              key={track.id}
            >
              <button
                type="button"
                className="mml-track-reorder-handle"
                aria-label={t("{name} 순서 이동", { name: track.name || `Track ${index + 1}` })}
                title={t("드래그해서 트랙 순서 변경")}
                disabled={recordState !== "idle"}
                onPointerDown={(event) => beginTrackReorder(event, track.id)}
                onKeyDown={(event) => moveTrackWithKeyboard(event, track.id, index)}
              >
                <span className="mml-track-grip-dots" aria-hidden="true" />
              </button>
              <label className="mml-track-batch-checkbox" title={t("여러 트랙을 함께 바꿀 때 선택")}>
                <input type="checkbox" checked={batchTrackIds.includes(track.id)} onChange={() => toggleBatchTrack(track.id)} aria-label={t("{name} 일괄 변경 선택", { name: track.name || `Track ${index + 1}` })} />
              </label>
              <button type="button" className="mml-track-select" onClick={() => selectTrack(track.id)} onDoubleClick={(event) => openTrackSettings(track.id, event)} aria-pressed={track.id === selectedTrack.id} aria-label={t("{name} 선택, 두 번 누르면 트랙 설정", { name: track.name || `Track ${index + 1}` })} title={t("두 번 누르면 트랙 설정")}>
                <span><strong>{track.name || `Track ${index + 1}`}</strong><small>{themes.find((theme) => theme.id === track.themeId)?.name ?? t("음색")}</small></span>
              </button>
              <div className="mml-track-actions" aria-label={t("{name} 빠른 설정", { name: track.name || `Track ${index + 1}` })}>
                <div className="mml-track-route-actions">
                  <button type="button" className={project.routing.left.includes(track.id) ? "is-on" : ""} aria-pressed={project.routing.left.includes(track.id)} aria-label={t("왼쪽 건반 연결")} title={t("왼쪽 건반 연결")} onClick={() => toggleRoute("left", track.id)}>L</button>
                  <button type="button" className={project.routing.right.includes(track.id) ? "is-on" : ""} aria-pressed={project.routing.right.includes(track.id)} aria-label={t("오른쪽 건반 연결")} title={t("오른쪽 건반 연결")} onClick={() => toggleRoute("right", track.id)}>R</button>
                </div>
                <div className="mml-track-play-actions">
                  <button type="button" className={track.muted ? "is-on" : ""} aria-pressed={track.muted} aria-label={t("음소거")} title={t("음소거")} onClick={() => updateTrack(track.id, trackAudibilityPatch(track, "mute"))}>M</button>
                  <button type="button" className={track.solo ? "is-on" : ""} aria-pressed={track.solo} aria-label={t("솔로")} title={t("솔로")} onClick={() => updateTrack(track.id, trackAudibilityPatch(track, "solo"))}>S</button>
                  <button type="button" className={`mml-track-visibility ${!track.pianoRollVisible ? "is-on is-hidden" : ""}`} aria-pressed={!track.pianoRollVisible} aria-label={t(track.pianoRollVisible ? "피아노롤 숨기기" : "피아노롤 보이기")} title={t(track.pianoRollVisible ? "피아노롤 숨기기" : "피아노롤 보이기")} onClick={() => updateTrack(track.id, { pianoRollVisible: !track.pianoRollVisible })}><span aria-hidden="true" /></button>
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="mml-track-add-button" onClick={addTrack} disabled={recordState !== "idle"}>＋ {t("트랙 추가")}</button>
        </aside>

        <button
          type="button"
          className="mml-track-collapse"
          aria-expanded={!mobileTrackListCollapsed}
          aria-label={t(mobileTrackListCollapsed ? "트랙 목록 펼치기" : "트랙 목록 접기")}
          title={t(mobileTrackListCollapsed ? "트랙 목록 펼치기" : "트랙 목록 접기")}
          onClick={() => setMobileTrackListCollapsed((collapsed) => !collapsed)}
        >
          {mobileTrackListCollapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          <span>{t(mobileTrackListCollapsed ? "펼치기" : "접기")}</span>
        </button>

        <div className="mml-work-area">
          <button
            type="button"
            className={`mml-note-select-toggle ${noteSelectMode ? "is-active" : ""}`}
            aria-pressed={noteSelectMode}
            aria-label={t(noteSelectMode ? "노트 범위 선택 끄기" : "노트 범위 선택")}
            title={t(noteSelectMode ? "선택 모드 끄기" : "드래그로 노트 선택")}
            onClick={() => {
              setNoteSelectMode((active) => !active);
              setNoteMarquee(null);
              pianoSelectionRef.current = null;
            }}
          >
            <MousePointer2 aria-hidden="true" />
            <span>{t(noteSelectMode ? "선택 중" : "선택")}</span>
          </button>
          <div className="mml-zoom-controls" aria-label={t("피아노롤 확대 축소")} title={t("Alt+휠 시간축 · Alt+Shift+휠 음정 간격")}>
            <div className="mml-zoom-group" aria-label={t("시간축 확대 축소")}>
              <span aria-hidden="true"><MoveHorizontal /></span>
              <button type="button" onClick={() => changeTimelineZoom(1 / 1.25)} aria-label={t("타임라인 축소")} title={t("타임라인 축소")}>−</button>
              <output aria-live="polite">{Math.round(timelineZoom * 100)}%</output>
              <button type="button" onClick={() => changeTimelineZoom(1.25)} aria-label={t("타임라인 확대")} title={t("타임라인 확대")}>＋</button>
            </div>
            <div className="mml-zoom-group" aria-label={t("음정 간격 확대 축소")}>
              <span aria-hidden="true"><MoveVertical /></span>
              <button type="button" onClick={() => changePitchZoom(1 / 1.2)} aria-label={t("음정 간격 축소")} title={t("음정 간격 축소")}>−</button>
              <output aria-live="polite">{Math.round(pitchZoom * 100)}%</output>
              <button type="button" onClick={() => changePitchZoom(1.2)} aria-label={t("음정 간격 확대")} title={t("음정 간격 확대")}>＋</button>
            </div>
          </div>
          {timelineEditor && (
            <div
              ref={timelineEditorRef}
              className="mml-timeline-editor"
              role="dialog"
              aria-label={t("박자와 템포 변경")}
              style={timelineEditor.x !== undefined && timelineEditor.y !== undefined ? { left: `${timelineEditor.x}px`, top: `${timelineEditor.y}px`, right: "auto", transform: "none" } : undefined}
            >
              <header>
                <span><strong>{t("박자·템포 변경")}</strong><small>{timelinePositionLabel(timelineEditor.tick)} · {Math.round(timelineEditor.tick)} tick · {timelineTempoTrack?.name ?? selectedTrack.name}</small></span>
                <button type="button" className="mml-panel-close" onClick={() => setTimelineEditor(null)} aria-label={t("박자·템포 변경 닫기")}><X aria-hidden="true" /></button>
              </header>
              <section>
                <label>{t("템포")}<input aria-label={t("변경 템포")} type="number" min="1" value={timelineEditor.bpm} onChange={(event) => setTimelineEditor({ ...timelineEditor, bpm: Math.max(1, Number(event.target.value) || 1) })} /></label>
                <span className="mml-timeline-unit">BPM</span>
                <button type="button" className="is-save" onClick={saveTimelineTempo}>{t("저장")}</button>
                <button type="button" className="is-delete" disabled={!trackTempoEvents.some((marker: any) => marker.tick === timelineEditor.tick && project.tracks[marker.trackIndex]?.id === timelineEditor.tempoTrackId)} onClick={deleteTimelineTempo}>{t("코드 삭제")}</button>
              </section>
              <section>
                <label>{t("박자표")}<span className="mml-timeline-fraction"><input aria-label={t("변경 박자 분자")} type="number" min="1" value={timelineEditor.numerator} onChange={(event) => setTimelineEditor({ ...timelineEditor, numerator: Math.max(1, Number(event.target.value) || 1) })} /><i>/</i><input aria-label={t("변경 박자 분모")} type="number" min="1" value={timelineEditor.denominator} onChange={(event) => setTimelineEditor({ ...timelineEditor, denominator: Math.max(1, Number(event.target.value) || 1) })} /></span></label>
                <button type="button" className="is-save" onClick={saveTimelineMeter}>{t("저장")}</button>
                <button type="button" className="is-delete" disabled={timelineEditor.tick === 0 || !project.timeSignatureMap.some((marker: any) => marker.tick === timelineEditor.tick)} onClick={deleteTimelineMeter}>{t("변경 삭제")}</button>
              </section>
              <div className="mml-timeline-change-list">
                <strong>{t("변경 지점")}</strong>
                {timelineChangeTicks.length ? timelineChangeTicks.map((tick) => {
                  const tempos = trackTempoEvents.filter((marker: any) => marker.tick === tick);
                  const meter = project.timeSignatureMap.find((marker: any) => marker.tick === tick);
                  const tempoText = tempos.map((tempo: any) => `${project.tracks[tempo.trackIndex]?.name ?? `Track ${tempo.trackIndex + 1}`} ♩ ${tempo.bpm}`).join(" · ");
                  return <button type="button" onClick={() => openTimelineEditor(tick)} key={`change-list-${tick}`}><span>{timelinePositionLabel(tick)}</span><small>{[tempoText, meter ? `${meter.numerator}/${meter.denominator}` : ""].filter(Boolean).join(" · ")}</small></button>;
                }) : <small>{t("추가한 변경 지점이 없습니다.")}</small>}
              </div>
              <p>{t("템포는 MML 트랙의 t 코드로 기록됩니다. 피아노롤에서 원하는 위치를 오른쪽 클릭해 변경 지점을 만들 수 있습니다.")}</p>
            </div>
          )}
          <div
            ref={pianoRollRef}
            className={`mml-piano-roll ${parseError ? "has-error" : ""} ${noteSelectMode ? "is-note-select-mode" : ""} ${noteMarquee ? "is-range-selecting" : ""}`}
            onContextMenu={timelineContext}
            onPointerDown={beginPianoSelection}
            onPointerMove={movePianoSelection}
            onPointerUp={endPianoSelection}
            onPointerCancel={endPianoSelection}
            onClick={(event) => {
            if (suppressPianoClickRef.current) {
              event.preventDefault();
              return;
            }
            if ((event.target as HTMLElement).closest(".mml-note-block")) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const rawTick = Math.round((event.clientX - rect.left + event.currentTarget.scrollLeft) / pianoPixelsPerTick);
            const tick = snapTickToGrid(rawTick, project.recording.quantize);
            playheadRef.current = Math.max(0, tick);
            setPlayhead(Math.max(0, tick));
            const selectedIndex = project.tracks.findIndex((track: any) => track.id === selectedTrack.id);
            const parsed = displayTracks[selectedIndex];
            const timelineItems = [...(parsed?.notes ?? []), ...(parsed?.rests ?? [])].sort((a: any, b: any) => a.tick - b.tick);
            const target = timelineItems.find((item: any) => item.tick >= tick) ?? timelineItems.at(-1);
            const caret = target?.sourceStart ?? selectedTrack.sourceText.length;
            window.requestAnimationFrame(() => {
              editorRef.current?.focus();
              editorRef.current?.setSelectionRange(caret, caret);
            });
          }}>
            <div ref={pianoCanvasRef} className="mml-piano-canvas" style={{ width: pianoWidth, height: pianoHeight }}>
              <div ref={pianoPitchLabelsRef} className="mml-pitch-label-layer">
                {Array.from({ length: maxMidi - minMidi + 1 }, (_, index) => {
                  const midi = maxMidi - index;
                  return ((midi % 12) + 12) % 12 === 0
                    ? <em className="mml-pitch-label" style={{ top: `${index * pixelsPerPitch}px`, height: `${pixelsPerPitch}px` }} key={`pitch-label-${midi}`}>{noteLabel(midi)}</em>
                    : null;
                })}
              </div>
              <div ref={pianoRulerRef} className="mml-timeline-ruler">
                {timelineGrid.measures.map((measure: any) => <span className="mml-measure-label" data-tick={measure.tick} style={{ left: `${tickToPianoX(measure.tick)}px` }} key={`measure-label-${measure.tick}`}>{measure.number}</span>)}
                {timelineChangeTicks.map((tick) => {
                  const tempos = trackTempoEvents.filter((marker: any) => marker.tick === tick);
                  const meter = project.timeSignatureMap.find((marker: any) => marker.tick === tick);
                  const tempoText = tempos.length > 1 ? `♩${tempos.length}` : tempos[0] ? `♩${tempos[0].bpm}` : "";
                  const text = [tempoText, meter ? `${meter.numerator}/${meter.denominator}` : ""].filter(Boolean).join(" · ");
                  return <button type="button" className="mml-change-marker" data-tick={tick} style={{ left: `${Math.max(4, tickToPianoX(tick))}px` }} onClick={(event) => { event.stopPropagation(); openTimelineEditor(tick); }} title={t("{position} 변경 편집", { position: timelinePositionLabel(tick) })} key={`change-marker-${tick}`}>{text}</button>;
                })}
              </div>
              <div ref={pianoGridRef} className="mml-piano-grid">
                {Array.from({ length: maxMidi - minMidi + 1 }, (_, index) => {
                  const midi = maxMidi - index;
                  const pitchClass = ((midi % 12) + 12) % 12;
                  return <span className={`mml-pitch-row ${[1, 3, 6, 8, 10].includes(pitchClass) ? "is-accidental" : ""}`} style={{ top: `${index * pixelsPerPitch}px`, height: `${pixelsPerPitch}px` }} key={`pitch-${midi}`} />;
                })}
                {quantizeLines.map((tick) => <i className="mml-quantize-line" style={{ left: `${tickToPianoX(tick)}px` }} key={`quantize-${tick}`} />)}
                {timelineGrid.beats.map((beat: any) => <i className="mml-beat-line" style={{ left: `${tickToPianoX(beat.tick)}px` }} key={`beat-${beat.tick}`} />)}
                {timelineGrid.measures.map((measure: any) => <i className="mml-measure-line" style={{ left: `${tickToPianoX(measure.tick)}px` }} key={`measure-line-${measure.tick}`} />)}
                {visibleNotes.map((note: any) => {
                  const track = project.tracks[note.trackIndex];
                  const selected = track.id === selectedTrack.id;
                  const rangeSelected = selected
                    && sourceSelection?.trackId === track.id
                    && note.sourceStart < sourceSelection.end
                    && note.sourceEnd > sourceSelection.start;
                  return <button type="button" className={`mml-note-block ${selected ? "is-selected" : ""} ${rangeSelected ? "is-range-selected" : ""}`} style={{ left: `${tickToPianoX(note.tick)}px`, width: `${Math.max(4, tickToPianoX(note.duration))}px`, top: `${(maxMidi - note.midi) * pixelsPerPitch}px`, height: `${Math.max(5, pixelsPerPitch - 1)}px`, background: track.color }} key={`${track.id}-${note.sourceStart}-${note.tick}`} onClick={(event) => {
                    if (suppressPianoClickRef.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    selectPianoNote(note.trackIndex, note);
                  }} title={`${track.name} · ${noteLabel(note.midi)}`} />;
                })}
                {liveRecordingNotes.map((note) => <i aria-hidden="true" className="mml-note-block is-live-recording" style={{ left: `${tickToPianoX(note.tick)}px`, width: `${Math.max(4, tickToPianoX(note.duration))}px`, top: `${(maxMidi - note.midi) * pixelsPerPitch}px`, height: `${Math.max(5, pixelsPerPitch - 1)}px`, background: note.color }} key={`live-${note.id}`} />)}
                {noteMarquee && <i aria-hidden="true" className="mml-note-marquee" style={{
                  left: `${Math.min(noteMarquee.startX, noteMarquee.endX)}px`,
                  top: `${Math.min(noteMarquee.startY, noteMarquee.endY)}px`,
                  width: `${Math.max(1, Math.abs(noteMarquee.endX - noteMarquee.startX))}px`,
                  height: `${Math.max(1, Math.abs(noteMarquee.endY - noteMarquee.startY))}px`,
                }} />}
                <i className="mml-playhead" style={{ left: `${playheadX}px` }} />
              </div>
            </div>
          </div>

          <div className="mml-editor-head">
            <i style={{ background: selectedTrack.color }} />
            <strong>{selectedTrack.name}</strong>
            <small>{t(project.recording.mode === "realtime" ? "실시간" : "이어붙이기")} · {t(project.recording.editMode === "overwrite" ? "수정" : "삽입")} · {project.recording.quantize === "off" ? t("보정 없음") : t("{value} 보정", { value: project.recording.quantize })}</small>
            <div className="mml-editor-actions">
              <button type="button" className="mml-editor-done" onClick={() => editorRef.current?.blur()}>{t("완료")}</button>
              <button type="button" onClick={optimizeSelectedTrack} disabled={playing || recordState !== "idle"} title={t("연주를 그대로 유지하면서 MML 코드를 짧게 정리")}>{t("최적화")}</button>
              <button type="button" onClick={expandSelectedTrack} disabled={playing || recordState !== "idle"} title={t("n코드와 생략된 음가를 음이름·명시적 음가로 풀어쓰기")}>{t("풀어쓰기")}</button>
              <button type="button" onClick={() => void writeAppClipboard(selectedTrack.sourceText)}>{t("복사")}</button>
            </div>
          </div>
          {playing ? (
            <pre className="mml-playback-source" aria-label={t("{name} MML 재생 위치", { name: selectedTrack.name })}>
              {playbackSourceRange ? <>{selectedTrack.sourceText.slice(0, playbackSourceRange.start)}<mark>{selectedTrack.sourceText.slice(playbackSourceRange.start, playbackSourceRange.end)}</mark>{selectedTrack.sourceText.slice(playbackSourceRange.end)}</> : selectedTrack.sourceText}
            </pre>
          ) : <textarea ref={editorRef} className={parseError && project.tracks[parseError.trackIndex]?.id === selectedTrack.id ? "has-error" : ""} spellCheck={false} readOnly={recordState !== "idle"} value={selectedTrack.sourceText} onChange={(event) => updateTrack(selectedTrack.id, { sourceText: event.target.value })} onSelect={(event) => syncSourceSelectionFromEditor(event.currentTarget)} onKeyUp={(event) => syncSourceSelectionFromEditor(event.currentTarget)} onPointerUp={(event) => syncSourceSelectionFromEditor(event.currentTarget)} onBlur={(event) => {
            if ((event.relatedTarget as HTMLElement | null)?.closest(".mml-note-block, .mml-duration-menu")) return;
            clearSourceSelection();
          }} onContextMenu={(event) => {
            const editor = event.currentTarget;
            if (editor.selectionStart === editor.selectionEnd) return;
            event.preventDefault();
            event.stopPropagation();
            const studio = editor.closest(".mml-studio")?.getBoundingClientRect();
            if (!studio) return;
            setDurationMenu({
              x: Math.max(8, Math.min(studio.width - 244, event.clientX - studio.left)),
              y: Math.max(8, Math.min(studio.height - 382, event.clientY - studio.top)),
              trackId: selectedTrack.id,
              start: editor.selectionStart,
              end: editor.selectionEnd,
            });
          }} onPaste={(event) => {
            const text = event.clipboardData.getData("text").replace(/^\uFEFF/, "");
            if (!/^\s*MML@/i.test(text)) return;
            event.preventDefault();
            try {
              const parsed = parseMmlDocument(text);
              const ranges = parsed.tracks.map((track: any) => text.slice(track.sourceStart, track.sourceEnd));
              setImportPayload({ ranges });
            } catch (error) {
              window.alert(t("붙여넣은 MML을 나누지 못했습니다.\n{message}", { message: (error as Error).message }));
            }
          }} aria-label={t("{name} MML 편집", { name: selectedTrack.name })} />}
          <div className="mml-status-line">
            <span>{t("MML {count}자 · 재생 {current} / {total} · {bpm} BPM · {meter}", { count: selectedTrackCharacterCount.toLocaleString(), current: formatPlaybackTime(currentPlaybackSeconds), total: formatPlaybackTime(totalPlaybackSeconds), bpm: recordTempo, meter: `${recordMeter.numerator}/${recordMeter.denominator}` })}</span>
            <span>{parseError
              ? t("Track {track} · {line}줄 {column}자 · {message}", { track: parseError.trackIndex + 1, line: parseError.line, column: parseError.column, message: parseError.message })
              : tempoConflict || (droppedCount > 0 ? t("놓친 음 {count}개", { count: droppedCount }) : recordingMessage)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
