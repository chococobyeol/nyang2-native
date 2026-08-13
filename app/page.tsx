"use client";

/* eslint-disable @next/next/no-img-element */

import {
  CSSProperties,
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorkletSynthesizer } from "spessasynth_lib";
import spessaProcessorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import { ExternalLink, Languages, RotateCcw, Settings as SettingsIcon, X } from "lucide-react";
import { chooseSecondKeyboardOctave } from "./octave-selection";
import MmlStudio, { type MmlInputSink } from "./components/mml-studio";
import RangeControl from "./components/range-control";
import { LOCALE_OPTIONS, useI18n, type Locale } from "./i18n";
import {
  deleteStoredSoundPack,
  loadStoredSoundPack,
  parseSoundPackFile,
  parseSoundPackThemeId,
  saveStoredSoundPack,
  type StoredSoundPack,
} from "./sound-pack";

type NoteLabelMode = "hidden" | "base" | "transposed";
type AccidentalStyle = "sharp" | "flat";
type KeyboardSide = "left" | "right";
type TransposeShortcutAction = "downSemitone" | "upSemitone" | "downFifth" | "upFifth" | "reset";

type TransposeShortcuts = Record<TransposeShortcutAction, string>;

type Settings = {
  keyboardCount: 1 | 2;
  leftOctavePresets: [number, number, number, number];
  rightOctavePresets: [number, number, number, number];
  leftShowLowerB: boolean;
  leftShowUpperC: boolean;
  rightShowLowerB: boolean;
  rightShowUpperC: boolean;
  noteLabelMode: NoteLabelMode;
  accidentalStyle: AccidentalStyle;
  showKeyMapping: boolean;
  mobileLandscape: boolean;
  leftMapping: string[];
  rightMapping: string[];
  octaveShortcuts: string[];
  transposeShortcuts: TransposeShortcuts;
  masterVolume: number;
  themeId: string;
};

type Theme = {
  id: string;
  name: string;
  description: string;
  waveform: OscillatorType;
  harmonic: OscillatorType;
  harmonicGain: number;
  accent: string;
  accentSoft: string;
  keyAccent: string;
  visuals: {
    pawPad: string;
    mouthClosed: string;
    mouthOpen: string;
    bodyMiddle: string;
    bodyEnd: string;
  };
};

type AudioGraph = {
  context: AudioContext;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  reverbImpulse: AudioBuffer;
};

type SampleVoiceState = {
  buffer: AudioBuffer;
  playbackRate: number;
  sourceOffset: number;
  startedAt: number;
  dryEnded: boolean;
  sustainLatched: boolean;
  tailStarted: boolean;
  holdTimer: number | null;
  cleanupTimer: number | null;
  tailGain: GainNode | null;
};

type Voice = {
  id: string;
  inputId: string;
  keyId: string;
  baseMidi: number;
  pitchClass: number;
  gain?: GainNode;
  outputNode?: AudioNode;
  sources: AudioScheduledSourceNode[];
  scheduledStartAt: number;
  sampleState?: SampleVoiceState;
  soundPackState?: {
    synth: WorkletSynthesizer;
    channel: number;
    midi: number;
    scheduledStartAt: number;
  };
  released: boolean;
  stopped: boolean;
};

type CaptureTarget =
  | { kind: "note"; side: KeyboardSide; index: number }
  | { kind: "octave"; index: number }
  | { kind: "transpose"; action: TransposeShortcutAction }
  | null;

type NoteStartOptions = {
  soundingMidi?: number;
  themeId?: string;
  volume?: number;
  keyId?: string;
  skipRecording?: boolean;
  recordingAt?: number;
  audioDelaySeconds?: number;
  mmlTrackId?: string;
  outputNode?: AudioNode;
};

type MmlTrackMixState = {
  trackId: string;
  themeId: string;
  volume: number;
  audible: boolean;
};

function inputEventSeconds(event: { timeStamp: number }) {
  const now = performance.now();
  const timestamp = Number(event.timeStamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) return now / 1000;
  const relativeTimestamp = timestamp > 1_000_000_000_000
    ? timestamp - performance.timeOrigin
    : timestamp;
  return Math.abs(relativeTimestamp - now) < 60_000 ? relativeTimestamp / 1000 : now / 1000;
}

const STORAGE_KEY = "nyangnyang-settings-v1";
const NOTE_OFFSETS = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const WHITE_OFFSETS = [-1, 0, 2, 4, 5, 7, 9, 11, 12];
const BLACK_OFFSETS = [1, 3, 6, 8, 10];
const LEFT_MAPPING = [
  "Digit1",
  "KeyQ",
  "Digit2",
  "KeyW",
  "Digit3",
  "KeyE",
  "KeyR",
  "Digit5",
  "KeyT",
  "Digit6",
  "KeyY",
  "Digit7",
  "KeyU",
  "KeyI",
];
const RIGHT_MAPPING = [
  "KeyX",
  "KeyC",
  "KeyF",
  "KeyV",
  "KeyG",
  "KeyB",
  "KeyN",
  "KeyJ",
  "KeyM",
  "KeyK",
  "Comma",
  "KeyL",
  "Period",
  "Slash",
];
const OCTAVE_SHORTCUTS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"];
const TRANSPOSE_SHORTCUTS: TransposeShortcuts = {
  downSemitone: "Minus",
  upSemitone: "Equal",
  downFifth: "BracketLeft",
  upFifth: "BracketRight",
  reset: "Backslash",
};
const TRANSPOSE_SHORTCUT_LABELS: Record<TransposeShortcutAction, string> = {
  downSemitone: "−1 반음",
  upSemitone: "+1 반음",
  downFifth: "−5도",
  upFifth: "+5도",
  reset: "C로 초기화",
};

const NYANG_SAMPLE = { midi: 64, url: "/audio/nyang/e4.mp3" } as const;
const NYANG_SAMPLE_START_OFFSET_SECONDS = 0.032;
const NYANG_LONG_PRESS_MS = 260;
const NYANG_TAIL_SOURCE_SECONDS = 0.22;
const NYANG_REVERB_SECONDS = 2.6;

const DEFAULT_SETTINGS: Settings = {
  keyboardCount: 1,
  leftOctavePresets: [2, 3, 4, 5],
  rightOctavePresets: [3, 4, 5, 6],
  leftShowLowerB: true,
  leftShowUpperC: true,
  rightShowLowerB: true,
  rightShowUpperC: true,
  noteLabelMode: "base",
  accidentalStyle: "sharp",
  showKeyMapping: true,
  mobileLandscape: true,
  leftMapping: LEFT_MAPPING,
  rightMapping: RIGHT_MAPPING,
  octaveShortcuts: OCTAVE_SHORTCUTS,
  transposeShortcuts: TRANSPOSE_SHORTCUTS,
  masterVolume: 0.72,
  themeId: "nyang-voice",
};

const DEFAULT_VISUALS = {
  pawPad: "/assets/themes/default/pawpad.svg",
  mouthClosed: "/assets/themes/default/mouth-close.svg",
  mouthOpen: "/assets/themes/default/mouth-open.svg",
  bodyMiddle: "/assets/themes/default/body-middle.svg",
  bodyEnd: "/assets/themes/default/body-end.svg",
};

const THEMES: Theme[] = [
  {
    id: "nyang-voice",
    name: "냥 보이스",
    description: "냥..",
    waveform: "triangle",
    harmonic: "sine",
    harmonicGain: 0.18,
    accent: "#ef6b5a",
    accentSoft: "#ffd9d2",
    keyAccent: "#f3b7ad",
    visuals: DEFAULT_VISUALS,
  },
  {
    id: "soft-synth",
    name: "포근 신스",
    description: "부드럽고 둥근 합성음",
    waveform: "triangle",
    harmonic: "sine",
    harmonicGain: 0.18,
    accent: "#c98a2f",
    accentSoft: "#f5dfb4",
    keyAccent: "#e8bc70",
    visuals: DEFAULT_VISUALS,
  },
  {
    id: "glass-bell",
    name: "유리 방울",
    description: "맑고 가벼운 합성음",
    waveform: "sine",
    harmonic: "triangle",
    harmonicGain: 0.28,
    accent: "#3e8f98",
    accentSoft: "#ccebed",
    keyAccent: "#9ed7dc",
    visuals: DEFAULT_VISUALS,
  },
  {
    id: "soft-organ",
    name: "말랑 오르간",
    description: "길고 포근한 합성음",
    waveform: "square",
    harmonic: "sine",
    harmonicGain: 0.12,
    accent: "#7769b5",
    accentSoft: "#ded8f5",
    keyAccent: "#c1b5ea",
    visuals: DEFAULT_VISUALS,
  },
];

const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

function mod(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function noteName(value: number, style: AccidentalStyle) {
  return (style === "sharp" ? SHARP_NAMES : FLAT_NAMES)[mod(value, 12)];
}

function codeLabel(code: string) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const labels: Record<string, string> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
  };
  return labels[code] ?? code.replace(/^Numpad/, "Num ");
}

function shortcutCodeLabel(shortcut: string) {
  return shortcut.split("+").map(codeLabel).join("+");
}

function createReverbImpulse(context: AudioContext) {
  const length = Math.round(context.sampleRate * NYANG_REVERB_SECONDS);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let seed = 20260801;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    let softened = 0;
    for (let index = 0; index < length; index += 1) {
      const progress = index / length;
      const noise = random() * 2 - 1;
      softened = softened * 0.56 + noise * 0.44;
      data[index] = softened * (1 - progress) ** 3.2;
    }
  }
  return impulse;
}

function sanitizeSettings(raw: unknown): Settings {
  const value = raw && typeof raw === "object" ? (raw as Partial<Settings>) : {};
  const legacy = value as Partial<Settings> & {
    octavePresets?: unknown;
    showLowerB?: boolean;
    showUpperC?: boolean;
  };
  const normalizePresets = (candidate: unknown, fallback: Settings["leftOctavePresets"]) => {
    const presets = Array.isArray(candidate)
      ? candidate.slice(0, 4).map((item, index) => {
        const parsed = Number(item);
        return Number.isFinite(parsed)
          ? Math.max(0, Math.min(8, Math.round(parsed)))
          : fallback[index];
      })
      : [...fallback];
    while (presets.length < 4) presets.push(fallback[presets.length]);
    return presets as Settings["leftOctavePresets"];
  };
  const leftPresets = normalizePresets(
    value.leftOctavePresets ?? legacy.octavePresets,
    DEFAULT_SETTINGS.leftOctavePresets,
  );
  const rightPresets = normalizePresets(
    value.rightOctavePresets,
    DEFAULT_SETTINGS.rightOctavePresets,
  );
  const validMapping = (candidate: unknown, fallback: string[]) =>
    Array.isArray(candidate) && candidate.length === NOTE_OFFSETS.length
      ? candidate.map((item, index) => (typeof item === "string" ? item : fallback[index]))
      : fallback;
  const validOctaveShortcuts = Array.isArray(value.octaveShortcuts) && value.octaveShortcuts.length === 8
    ? value.octaveShortcuts.map((item, index) => (typeof item === "string" ? item : OCTAVE_SHORTCUTS[index]))
    : OCTAVE_SHORTCUTS;
  const legacyLowerB = typeof legacy.showLowerB === "boolean" ? legacy.showLowerB : true;
  const legacyUpperC = typeof legacy.showUpperC === "boolean" ? legacy.showUpperC : true;
  const transposeShortcuts = value.transposeShortcuts && typeof value.transposeShortcuts === "object"
    ? Object.fromEntries(
        (Object.keys(TRANSPOSE_SHORTCUTS) as TransposeShortcutAction[]).map((action) => [
          action,
          typeof value.transposeShortcuts?.[action] === "string"
            ? value.transposeShortcuts[action]
            : TRANSPOSE_SHORTCUTS[action],
        ]),
      ) as TransposeShortcuts
    : TRANSPOSE_SHORTCUTS;

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    keyboardCount: value.keyboardCount === 2 ? 2 : 1,
    leftOctavePresets: leftPresets,
    rightOctavePresets: rightPresets,
    leftShowLowerB: typeof value.leftShowLowerB === "boolean" ? value.leftShowLowerB : legacyLowerB,
    leftShowUpperC: typeof value.leftShowUpperC === "boolean" ? value.leftShowUpperC : legacyUpperC,
    rightShowLowerB: typeof value.rightShowLowerB === "boolean" ? value.rightShowLowerB : legacyLowerB,
    rightShowUpperC: typeof value.rightShowUpperC === "boolean" ? value.rightShowUpperC : legacyUpperC,
    noteLabelMode: ["hidden", "base", "transposed"].includes(value.noteLabelMode ?? "")
      ? (value.noteLabelMode as NoteLabelMode)
      : DEFAULT_SETTINGS.noteLabelMode,
    accidentalStyle: value.accidentalStyle === "flat" ? "flat" : "sharp",
    leftMapping: validMapping(value.leftMapping, LEFT_MAPPING),
    rightMapping: validMapping(value.rightMapping, RIGHT_MAPPING),
    octaveShortcuts: validOctaveShortcuts,
    transposeShortcuts,
    themeId: value.themeId === "warm-cat"
      ? "nyang-voice"
      : THEMES.some((theme) => theme.id === value.themeId) || (typeof value.themeId === "string" && parseSoundPackThemeId(value.themeId))
        ? value.themeId as string
        : DEFAULT_SETTINGS.themeId,
    masterVolume: Math.max(0, Math.min(1, Number(value.masterVolume ?? DEFAULT_SETTINGS.masterVolume))),
  };
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <span className={`toggle ${checked ? "is-on" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-knob" />
      </span>
    </label>
  );
}

function OctavePresetInput({
  sideLabel,
  index,
  value,
  onCommit,
}: {
  sideLabel: string;
  index: number;
  value: number;
  onCommit: (value: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    if (draft === "") {
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(0, Math.min(8, Math.round(parsed)));
    setDraft(String(next));
    onCommit(next);
  };

  return (
    <label>
      <span>O</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-8]*"
        value={draft}
        aria-label={t("{side} {index}번 옥타브 값", { side: sideLabel, index: index + 1 })}
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const next = event.target.value;
          if (/^\d?$/.test(next)) setDraft(next);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

type KeyboardGroupProps = {
  side: KeyboardSide;
  octave: number;
  showSideLabel?: boolean;
  settings: Settings;
  mapping: string[];
  transpose: number;
  activeKeys: Set<string>;
  pawPad: string;
  onPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    side: KeyboardSide,
    offset: number,
  ) => void;
  restControl?: {
    active: boolean;
    shortcut: string;
    showNoteLabel: boolean;
    showShortcut: boolean;
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onClick: () => void;
  };
};

function KeyboardGroup({
  side,
  octave,
  showSideLabel = false,
  settings,
  mapping,
  transpose,
  activeKeys,
  pawPad,
  onPointerDown,
  restControl,
}: KeyboardGroupProps) {
  const { t } = useI18n();
  const showLowerB = side === "left" ? settings.leftShowLowerB : settings.rightShowLowerB;
  const showUpperC = side === "left" ? settings.leftShowUpperC : settings.rightShowUpperC;
  const visibleWhites = WHITE_OFFSETS.filter(
    (offset) => (offset !== -1 || showLowerB) && (offset !== 12 || showUpperC),
  );

  const labelFor = (offset: number) => {
    if (settings.noteLabelMode === "hidden") return "";
    return noteName(
      settings.noteLabelMode === "transposed" ? offset + transpose : offset,
      settings.accidentalStyle,
    );
  };

  const mappingFor = (offset: number) => {
    const index = NOTE_OFFSETS.indexOf(offset);
    return index >= 0 ? codeLabel(mapping[index]) : "";
  };

  return (
    <div className="paw-keyboard-group" aria-label={t("{side} O{octave} 발바닥 음판", { side: t(side === "left" ? "왼쪽" : "오른쪽"), octave })}>
      {showSideLabel && (
        <span className={`keyboard-side-code is-${side}`} aria-hidden="true">{side === "left" ? "L" : "R"}</span>
      )}
      <div className="paw-row paw-row-natural">
        {visibleWhites.map((offset) => {
          const keyId = `${side}:${offset}`;
          const active = activeKeys.has(keyId);
          const edgeNote = offset === -1 || offset === 12;
          return (
            <button
              type="button"
              className={`paw-note paw-note-natural ${edgeNote ? "is-edge-note" : ""} ${active ? "is-active" : ""}`}
              key={keyId}
              data-piano-key={keyId}
              data-side={side}
              data-offset={offset}
              aria-label={t("{note} 음", { note: labelFor(offset) || noteName(offset, settings.accidentalStyle) })}
              onPointerDown={(event) => onPointerDown(event, side, offset)}
            >
              <img className="paw-mark" src={pawPad} alt="" draggable={false} />
              <span className="key-labels">
                {settings.noteLabelMode !== "hidden" && <span className="note-label">{labelFor(offset)}</span>}
                {settings.showKeyMapping && <span className="mapping-label">{mappingFor(offset)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="paw-row paw-row-accidental" aria-hidden="false">
        {BLACK_OFFSETS.map((offset) => {
          const previousWhiteOffset = offset === 1 ? 0 : offset === 3 ? 2 : offset === 6 ? 5 : offset === 8 ? 7 : 9;
          const previousIndex = visibleWhites.indexOf(previousWhiteOffset);
          if (previousIndex < 0) return null;
          const left = ((previousIndex + 1) / visibleWhites.length) * 100;
          const keyId = `${side}:${offset}`;
          const active = activeKeys.has(keyId);
          return (
            <button
              type="button"
              className={`paw-note paw-note-accidental ${active ? "is-active" : ""}`}
              style={{ left: `${left}%`, width: `${Math.min(10.5, 88 / visibleWhites.length)}%` }}
              key={keyId}
              data-piano-key={keyId}
              data-side={side}
              data-offset={offset}
              aria-label={t("{note} 음", { note: labelFor(offset) || noteName(offset, settings.accidentalStyle) })}
              onPointerDown={(event) => onPointerDown(event, side, offset)}
            >
              <img className="paw-mark" src={pawPad} alt="" draggable={false} />
              <span className="key-labels">
                {settings.noteLabelMode !== "hidden" && <span className="note-label">{labelFor(offset)}</span>}
                {settings.showKeyMapping && <span className="mapping-label">{mappingFor(offset)}</span>}
              </span>
            </button>
          );
        })}
        {restControl && (
          <button
            type="button"
            className={`paw-note paw-note-accidental mml-rest-button ${restControl.active ? "is-active" : ""}`}
            style={{
              left: `${((((visibleWhites.indexOf(2) + 1) / visibleWhites.length) + ((visibleWhites.indexOf(5) + 1) / visibleWhites.length)) / 2) * 100}%`,
              width: `${Math.min(10.5, 88 / visibleWhites.length)}%`,
            }}
            aria-label={t("쉼표 입력, {shortcut} 키, 누르는 동안 길이 지정", { shortcut: restControl.shortcut })}
            title={t("누르는 동안 쉼표 입력 · {shortcut}", { shortcut: restControl.shortcut })}
            onPointerDown={restControl.onPointerDown}
            onPointerUp={restControl.onPointerUp}
            onPointerCancel={restControl.onPointerCancel}
            onClick={restControl.onClick}
          >
            <img
              className="mml-rest-mark"
              src="/assets/themes/default/rest.svg"
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            {(restControl.showNoteLabel || restControl.showShortcut) && (
              <span className="mml-rest-labels" aria-hidden="true">
                {restControl.showNoteLabel && <span className="mml-rest-note">R</span>}
                {restControl.showShortcut && <kbd className="mml-rest-shortcut">{restControl.shortcut}</kbd>}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const { locale, setLocale, brandName, t } = useI18n();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mmlOpen, setMmlOpen] = useState(false);
  const [mmlExpanded, setMmlExpanded] = useState(false);
  const [leftOctave, setLeftOctave] = useState(4);
  const [rightOctave, setRightOctave] = useState(5);
  const [transpose, setTranspose] = useState(0);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const [sustainPressed, setSustainPressed] = useState(false);
  const [mmlRestShortcut, setMmlRestShortcut] = useState("KeyS");
  const [mmlPlayShortcut, setMmlPlayShortcut] = useState("Space");
  const [mmlRestPressed, setMmlRestPressed] = useState(false);
  const [lastCatPitchClass, setLastCatPitchClass] = useState(11);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget>(null);
  const [mappingError, setMappingError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [soundPack, setSoundPack] = useState<StoredSoundPack | null>(null);
  const [soundPackStatus, setSoundPackStatus] = useState("");
  const [soundPackBusy, setSoundPackBusy] = useState(false);

  const settingsRef = useRef(settings);
  const leftOctaveRef = useRef(leftOctave);
  const rightOctaveRef = useRef(rightOctave);
  const transposeRef = useRef(transpose);
  const sustainRef = useRef(sustainPressed);
  const captureRef = useRef<CaptureTarget>(null);
  const audioRef = useRef<AudioGraph | null>(null);
  const voicesRef = useRef<Map<string, Voice>>(new Map());
  const inputVoiceRef = useRef<Map<string, string>>(new Map());
  const pendingNoteRef = useRef<Map<string, number>>(new Map());
  const voiceCounterRef = useRef(0);
  const noteRequestCounterRef = useRef(0);
  const sampleDataRef = useRef<Map<string, Promise<ArrayBuffer>>>(new Map());
  const sampleBufferRef = useRef<Map<string, Promise<AudioBuffer>>>(new Map());
  const activePointersRef = useRef<Map<number, string>>(new Map());
  const mmlInputSinkRef = useRef<MmlInputSink | null>(null);
  const soundPackInputRef = useRef<HTMLInputElement | null>(null);
  const soundPackRef = useRef<StoredSoundPack | null>(null);
  const mmlTrackMixRef = useRef<Map<string, MmlTrackMixState>>(new Map());
  const mmlTrackGainRef = useRef<Map<string, GainNode>>(new Map());
  const soundPackSynthRef = useRef<{
    importedAt: number;
    synth: WorkletSynthesizer;
    channelByTheme: Map<string, number>;
    nextChannel: number;
  } | null>(null);
  const soundPackWorkletContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    document.title = brandName;
  }, [brandName]);

  const theme = useMemo(
    () => THEMES.find((candidate) => candidate.id === settings.themeId) ?? THEMES[0],
    [settings.themeId],
  );

  useEffect(() => {
    Object.values(theme.visuals).forEach((source) => {
      const image = new Image();
      image.src = source;
      void image.decode?.().catch(() => {
        // The visible image retries normally if eager decoding is unavailable.
      });
    });
  }, [theme.visuals]);

  const availableThemes = useMemo(() => [
    ...THEMES.map(({ id, name, accent }) => ({ id, name: t(name), accent })),
    ...(soundPack?.presets ?? []).map((preset) => ({
      id: preset.id,
      name: preset.name,
      accent: "#d49128",
    })),
  ], [soundPack, t]);

  const fetchSampleData = useCallback((url: string) => {
    const cached = sampleDataRef.current.get(url);
    if (cached) return cached;
    const request = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Audio file could not be loaded: ${url}`);
      return response.arrayBuffer();
    });
    sampleDataRef.current.set(url, request);
    return request;
  }, []);

  const loadSampleBuffer = useCallback((context: AudioContext, url: string) => {
    const cached = sampleBufferRef.current.get(url);
    if (cached) return cached;
    const request = fetchSampleData(url)
      .then((data) => context.decodeAudioData(data.slice(0)))
      .catch((error) => {
        sampleBufferRef.current.delete(url);
        throw error;
      });
    sampleBufferRef.current.set(url, request);
    return request;
  }, [fetchSampleData]);

  useEffect(() => {
    void fetchSampleData(NYANG_SAMPLE.url).catch(() => {
      sampleDataRef.current.delete(NYANG_SAMPLE.url);
    });
  }, [fetchSampleData]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    leftOctaveRef.current = leftOctave;
  }, [leftOctave]);
  useEffect(() => {
    rightOctaveRef.current = rightOctave;
  }, [rightOctave]);
  useEffect(() => {
    transposeRef.current = transpose;
  }, [transpose]);
  useEffect(() => {
    sustainRef.current = sustainPressed;
  }, [sustainPressed]);
  useEffect(() => {
    captureRef.current = captureTarget;
  }, [captureTarget]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) setSettings(sanitizeSettings(JSON.parse(saved)));
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      } finally {
        setHydrated(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let active = true;
    void loadStoredSoundPack()
      .then((stored) => {
        if (!active || !stored) return;
        soundPackRef.current = stored;
        setSoundPack(stored);
      })
      .catch(() => {
        if (active) setSoundPackStatus(t("저장된 사운드팩을 불러오지 못했습니다."));
      });
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    soundPackRef.current = soundPack;
  }, [soundPack]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [hydrated, settings]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const initAudio = useCallback(() => {
    if (!audioRef.current) {
      const AudioContextCtor = window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error(t("이 브라우저에서는 오디오를 사용할 수 없습니다."));
      const context = new AudioContextCtor({ latencyHint: "interactive" });
      const master = context.createGain();
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;
      master.gain.value = settingsRef.current.masterVolume;
      master.connect(compressor);
      compressor.connect(context.destination);
      audioRef.current = {
        context,
        master,
        compressor,
        reverbImpulse: createReverbImpulse(context),
      };
      void loadSampleBuffer(context, NYANG_SAMPLE.url).catch(() => {
        // If preload fails, the selected note retries and can fall back to the synth voice.
      });

      // Mobile Safari needs an audio graph to start directly inside the first touch gesture.
      const unlockSource = context.createBufferSource();
      unlockSource.buffer = context.createBuffer(1, 1, context.sampleRate);
      unlockSource.connect(context.destination);
      unlockSource.start(0);
    }
    if (audioRef.current.context.state !== "running") {
      void audioRef.current.context.resume().catch(() => {
        // A later touch gesture retries the resume operation.
      });
    }
    setAudioReady(true);
    return audioRef.current;
  }, [loadSampleBuffer, t]);

  const disposeSoundPackSynth = useCallback(() => {
    const current = soundPackSynthRef.current;
    if (!current) return;
    current.synth.stopAll(true);
    current.synth.disconnect();
    current.synth.destroy();
    soundPackSynthRef.current = null;
  }, []);

  const ensureSoundPackSynth = useCallback(async (graph: AudioGraph) => {
    const pack = soundPackRef.current;
    if (!pack) throw new Error(t("먼저 설정에서 사운드팩을 추가해 주세요."));
    const current = soundPackSynthRef.current;
    if (current?.importedAt === pack.importedAt) return current;
    disposeSoundPackSynth();

    if (soundPackWorkletContextRef.current !== graph.context) {
      await graph.context.audioWorklet.addModule(spessaProcessorUrl);
      soundPackWorkletContextRef.current = graph.context;
    }

    const { WorkletSynthesizer: WorkletSynthesizerConstructor } = await import("spessasynth_lib");
    // Chromium limits a single AudioWorklet output to 32 channels. SpessaSynth's
    // one-output mode requests 34, so keep its regular stereo-output layout.
    const synth = new WorkletSynthesizerConstructor(graph.context, { oneOutput: false });
    synth.connect(graph.master);
    await synth.soundBankManager.addSoundBank(pack.dls.slice(0), `user-${pack.importedAt}`);
    await synth.isReady;
    const next = {
      importedAt: pack.importedAt,
      synth,
      channelByTheme: new Map<string, number>(),
      nextChannel: 0,
    };
    soundPackSynthRef.current = next;
    return next;
  }, [disposeSoundPackSynth, t]);

  const soundPackChannel = useCallback((loaded: NonNullable<typeof soundPackSynthRef.current>, themeId: string, at: number, channelKey = themeId) => {
    const existing = loaded.channelByTheme.get(channelKey);
    if (existing !== undefined) return existing;
    const patch = parseSoundPackThemeId(themeId);
    if (!patch) throw new Error(t("사운드팩 악기 정보를 읽지 못했습니다."));
    const channel = loaded.nextChannel % 16;
    loaded.nextChannel += 1;
    loaded.channelByTheme.set(channelKey, channel);
    loaded.synth.midiChannels[channel].setDrums(patch.isDrum);
    loaded.synth.controllerChange(channel, 0, patch.bankMSB, { time: at });
    loaded.synth.controllerChange(channel, 32, patch.bankLSB, { time: at });
    loaded.synth.programChange(channel, patch.program, { time: at });
    return channel;
  }, [t]);

  useEffect(() => {
    const unlockAudio = () => {
      try {
        initAudio();
      } catch {
        // Unsupported browsers are handled when a note is pressed.
      }
    };
    window.addEventListener("touchstart", unlockAudio, { passive: true, capture: true });
    return () => window.removeEventListener("touchstart", unlockAudio, { capture: true });
  }, [initAudio]);

  useEffect(() => {
    const graph = audioRef.current;
    if (!graph) return;
    graph.master.gain.setTargetAtTime(settings.masterVolume, graph.context.currentTime, 0.02);
  }, [settings.masterVolume]);

  const refreshVoiceUI = useCallback(() => {
    const voices = [...voicesRef.current.values()].filter((voice) => !voice.stopped);
    const pressed = new Set(voices.filter((voice) => !voice.released).map((voice) => voice.keyId));
    setActiveKeys(pressed);

    const isSounding = voices.length > 0;
    setMouthOpen(isSounding);
    if (isSounding) {
      const highestBaseMidi = Math.max(...voices.map((voice) => voice.baseMidi));
      setLastCatPitchClass(mod(highestBaseMidi, 12));
    }
  }, []);

  const finishSampleVoice = useCallback((voice: Voice) => {
    if (voice.stopped) return;
    voice.stopped = true;
    const state = voice.sampleState;
    if (state?.holdTimer !== null && state?.holdTimer !== undefined) window.clearTimeout(state.holdTimer);
    if (state?.cleanupTimer !== null && state?.cleanupTimer !== undefined) window.clearTimeout(state.cleanupTimer);
    voicesRef.current.delete(voice.id);
    if (inputVoiceRef.current.get(voice.inputId) === voice.id) inputVoiceRef.current.delete(voice.inputId);
    refreshVoiceUI();
  }, [refreshVoiceUI]);

  const triggerSampleTail = useCallback((voice: Voice) => {
    const graph = audioRef.current;
    const state = voice.sampleState;
    if (!graph || !state || state.tailStarted || voice.stopped) return;
    state.tailStarted = true;
    if (state.holdTimer !== null) {
      window.clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }

    const source = graph.context.createBufferSource();
    const convolver = graph.context.createConvolver();
    const tailGain = graph.context.createGain();
    const offset = Math.max(state.sourceOffset, state.buffer.duration - NYANG_TAIL_SOURCE_SECONDS);
    const duration = Math.min(NYANG_TAIL_SOURCE_SECONDS, state.buffer.duration - offset);
    const naturalTailTime = state.startedAt + Math.max(0, offset - state.sourceOffset) / state.playbackRate;
    const startAt = Math.max(graph.context.currentTime, naturalTailTime);

    source.buffer = state.buffer;
    source.playbackRate.setValueAtTime(state.playbackRate, startAt);
    convolver.buffer = graph.reverbImpulse;
    tailGain.gain.value = 0.38;
    source.connect(convolver);
    convolver.connect(tailGain);
    tailGain.connect(voice.outputNode ?? graph.master);
    source.start(startAt, offset, duration);
    voice.sources.push(source);
    state.tailGain = tailGain;

    const tailDuration = Math.max(0, startAt - graph.context.currentTime) + duration / state.playbackRate + NYANG_REVERB_SECONDS;
    state.cleanupTimer = window.setTimeout(() => finishSampleVoice(voice), (tailDuration + 0.12) * 1000);
  }, [finishSampleVoice]);

  const stopVoice = useCallback(
    (voice: Voice, immediate = false) => {
      if (voice.stopped) return;
      voice.stopped = true;
      const graph = audioRef.current;
      if (voice.soundPackState) {
        const { synth, channel, midi, scheduledStartAt } = voice.soundPackState;
        const releaseAt = graph
          ? immediate ? graph.context.currentTime : Math.max(graph.context.currentTime, scheduledStartAt) + 0.001
          : undefined;
        synth.noteOff(channel, midi, releaseAt === undefined ? undefined : { time: releaseAt });
        voicesRef.current.delete(voice.id);
        refreshVoiceUI();
        return;
      }
      if (!graph || !voice.gain) return;
      const now = graph.context.currentTime;
      const cancelBeforeStart = immediate && voice.scheduledStartAt > now + 0.003;
      const sampleState = voice.sampleState;
      if (sampleState?.holdTimer !== null && sampleState?.holdTimer !== undefined) {
        window.clearTimeout(sampleState.holdTimer);
        sampleState.holdTimer = null;
      }
      if (sampleState?.cleanupTimer !== null && sampleState?.cleanupTimer !== undefined) {
        window.clearTimeout(sampleState.cleanupTimer);
        sampleState.cleanupTimer = null;
      }
      if (sampleState?.tailGain) {
        sampleState.tailGain.gain.cancelScheduledValues(now);
        sampleState.tailGain.gain.setValueAtTime(sampleState.tailGain.gain.value, now);
        sampleState.tailGain.gain.linearRampToValueAtTime(0, now + (immediate ? 0.02 : 0.12));
      }
      voice.gain.gain.cancelScheduledValues(now);
      if (cancelBeforeStart) {
        voice.gain.gain.setValueAtTime(0.0001, now);
      } else {
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + (immediate ? 0.008 : 0.16));
      }
      voice.sources.forEach((source) => {
        try {
          source.stop(cancelBeforeStart ? now : now + (immediate ? 0.012 : 0.2));
        } catch {
          // The source may already be stopped.
        }
      });
      window.setTimeout(
        () => {
          voicesRef.current.delete(voice.id);
          refreshVoiceUI();
        },
        immediate ? 60 : 230,
      );
      refreshVoiceUI();
    },
    [refreshVoiceUI],
  );

  const releaseInput = useCallback(
    (inputId: string, force = false, recordingAt = performance.now() / 1000) => {
      mmlInputSinkRef.current?.noteOff(inputId, recordingAt);
      pendingNoteRef.current.delete(inputId);
      const voiceId = inputVoiceRef.current.get(inputId);
      if (!voiceId) return;
      inputVoiceRef.current.delete(inputId);
      const voice = voicesRef.current.get(voiceId);
      if (!voice) return;
      voice.released = true;
      if (voice.sampleState && !force) {
        const state = voice.sampleState;
        if (state.holdTimer !== null) {
          window.clearTimeout(state.holdTimer);
          state.holdTimer = null;
        }
        if (sustainRef.current) {
          state.sustainLatched = true;
          triggerSampleTail(voice);
        }
        if (!state.sustainLatched) {
          stopVoice(voice, true);
          return;
        }
        refreshVoiceUI();
        return;
      }
      if (sustainRef.current && !force) {
        refreshVoiceUI();
        return;
      }
      stopVoice(voice, force);
    },
    [refreshVoiceUI, stopVoice, triggerSampleTail],
  );

  const startNote = useCallback(
    async (inputId: string, side: KeyboardSide, offset: number, options: NoteStartOptions = {}) => {
      const inputStartedAt = options.recordingAt ?? performance.now() / 1000;
      releaseInput(inputId, true, inputStartedAt);
      const requestId = ++noteRequestCounterRef.current;
      pendingNoteRef.current.set(inputId, requestId);
      let graph: AudioGraph;
      try {
        graph = initAudio();
      } catch {
        pendingNoteRef.current.delete(inputId);
        return;
      }
      const scheduledStartAt = graph.context.currentTime + Math.max(0, options.audioDelaySeconds ?? 0);

      const octave = side === "left" ? leftOctaveRef.current : rightOctaveRef.current;
      const baseMidi = options.soundingMidi ?? 12 * (octave + 1) + offset;
      const soundingMidi = options.soundingMidi ?? baseMidi + transposeRef.current;
      if (!options.skipRecording) {
        mmlInputSinkRef.current?.noteOn(inputId, side, soundingMidi, inputStartedAt);
      }
      const selectedThemeId = options.themeId ?? settingsRef.current.themeId;
      const soundPackPatch = parseSoundPackThemeId(selectedThemeId);
      if (soundPackPatch) {
        try {
          const loaded = await ensureSoundPackSynth(graph);
          if (pendingNoteRef.current.get(inputId) !== requestId) return;
          pendingNoteRef.current.delete(inputId);
          const now = Math.max(graph.context.currentTime, scheduledStartAt);
          const channelKey = options.mmlTrackId ? `${selectedThemeId}:${options.mmlTrackId}` : selectedThemeId;
          const channel = soundPackChannel(loaded, selectedThemeId, now, channelKey);
          const mix = options.mmlTrackId ? mmlTrackMixRef.current.get(options.mmlTrackId) : null;
          if (mix) loaded.synth.controllerChange(channel, 7, Math.round(127 * (mix.audible ? mix.volume : 0)), { time: now });
          const midi = Math.max(0, Math.min(127, Math.round(soundingMidi)));
          const velocity = Math.max(1, Math.min(127, Math.round(127 * Math.max(0, Math.min(1, options.volume ?? 1)))));
          loaded.synth.noteOn(channel, midi, velocity, { time: now });
          const voiceId = `voice-${++voiceCounterRef.current}`;
          const voice: Voice = {
            id: voiceId,
            inputId,
            keyId: options.keyId ?? `${side}:${offset}`,
            baseMidi,
            pitchClass: mod(baseMidi, 12),
            sources: [],
            scheduledStartAt: now,
            soundPackState: { synth: loaded.synth, channel, midi, scheduledStartAt: now },
            released: false,
            stopped: false,
          };
          voicesRef.current.set(voiceId, voice);
          inputVoiceRef.current.set(inputId, voiceId);
          setSoundPackStatus("");
          refreshVoiceUI();
          return;
        } catch (error) {
          pendingNoteRef.current.delete(inputId);
          setSoundPackStatus(t(error instanceof Error ? error.message : "사운드팩을 재생하지 못했습니다."));
          return;
        }
      }
      const rawFrequency = 440 * 2 ** ((soundingMidi - 69) / 12);
      const frequency = Number.isFinite(rawFrequency)
        ? Math.max(0.001, Math.min(graph.context.sampleRate * 8, rawFrequency))
        : rawFrequency > 0
          ? graph.context.sampleRate * 8
          : 0.001;
      const selectedTheme = THEMES.find((item) => item.id === selectedThemeId) ?? THEMES[0];
      const voiceVolume = Math.max(0, Math.min(1, options.volume ?? 1));
      let sampleBuffer: AudioBuffer | null = null;
      if (selectedTheme.id === "nyang-voice") {
        try {
          sampleBuffer = await loadSampleBuffer(graph.context, NYANG_SAMPLE.url);
        } catch {
          sampleBuffer = null;
        }
      }
      if (pendingNoteRef.current.get(inputId) !== requestId) return;
      pendingNoteRef.current.delete(inputId);

      const gain = graph.context.createGain();
      gain.gain.value = 0.0001;
      gain.connect(options.outputNode ?? graph.master);
      const now = Math.max(graph.context.currentTime, scheduledStartAt);
      const sources: AudioScheduledSourceNode[] = [];
      let sampleSource: AudioBufferSourceNode | null = null;
      let samplePlaybackRate = 1;
      let sampleSourceOffset = 0;

      if (sampleBuffer) {
        const source = graph.context.createBufferSource();
        const rawRate = 2 ** ((soundingMidi - NYANG_SAMPLE.midi) / 12);
        samplePlaybackRate = Math.max(0.0001, Math.min(1024, rawRate));
        source.buffer = sampleBuffer;
        source.playbackRate.setValueAtTime(samplePlaybackRate, now);
        source.connect(gain);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.82 * voiceVolume), now + 0.012);
        sampleSourceOffset = Math.min(NYANG_SAMPLE_START_OFFSET_SECONDS, Math.max(0, sampleBuffer.duration - 0.001));
        source.start(now, sampleSourceOffset);
        sources.push(source);
        sampleSource = source;
      } else {
        const primary = graph.context.createOscillator();
        primary.type = selectedTheme.waveform;
        primary.frequency.setValueAtTime(frequency, now);
        primary.connect(gain);

        const harmonic = graph.context.createOscillator();
        const harmonicGain = graph.context.createGain();
        harmonic.type = selectedTheme.harmonic;
        harmonic.frequency.setValueAtTime(Math.min(graph.context.sampleRate * 8, frequency * 2.003), now);
        harmonicGain.gain.value = selectedTheme.harmonicGain;
        harmonic.connect(harmonicGain);
        harmonicGain.connect(gain);

        const peak = (selectedTheme.id === "soft-organ" ? 0.17 : 0.24) * voiceVolume;
        const sustain = (selectedTheme.id === "glass-bell" ? 0.035 : selectedTheme.id === "soft-organ" ? 0.105 : 0.07) * voiceVolume;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(sustain, now + (selectedTheme.id === "glass-bell" ? 1.2 : 0.8));
        primary.start(now);
        harmonic.start(now);
        sources.push(primary, harmonic);
      }

      const voiceId = `voice-${++voiceCounterRef.current}`;
      const voice: Voice = {
        id: voiceId,
        inputId,
        keyId: options.keyId ?? `${side}:${offset}`,
        baseMidi,
        pitchClass: mod(baseMidi, 12),
        gain,
        outputNode: options.outputNode,
        sources,
        scheduledStartAt: now,
        sampleState: sampleSource && sampleBuffer
          ? {
              buffer: sampleBuffer,
              playbackRate: samplePlaybackRate,
              sourceOffset: sampleSourceOffset,
              startedAt: now,
              dryEnded: false,
              sustainLatched: false,
              tailStarted: false,
              holdTimer: null,
              cleanupTimer: null,
              tailGain: null,
            }
          : undefined,
        released: false,
        stopped: false,
      };
      voicesRef.current.set(voiceId, voice);
      inputVoiceRef.current.set(inputId, voiceId);
      if (sampleSource && voice.sampleState) {
        sampleSource.onended = () => {
          if (voice.stopped || voicesRef.current.get(voiceId) !== voice) return;
          if (voice.sampleState) voice.sampleState.dryEnded = true;
          if (!voice.sampleState?.tailStarted && voice.released) finishSampleVoice(voice);
        };
        const scheduledDelayMs = Math.max(0, now - graph.context.currentTime) * 1000;
        voice.sampleState.holdTimer = window.setTimeout(() => {
          if (!voice.released) triggerSampleTail(voice);
        }, scheduledDelayMs + NYANG_LONG_PRESS_MS);
        if (sustainRef.current) triggerSampleTail(voice);
      }
      refreshVoiceUI();
    },
    [ensureSoundPackSynth, finishSampleVoice, initAudio, loadSampleBuffer, refreshVoiceUI, releaseInput, soundPackChannel, t, triggerSampleTail],
  );

  const allNotesOff = useCallback(() => {
    pendingNoteRef.current.clear();
    inputVoiceRef.current.clear();
    activePointersRef.current.clear();
    voicesRef.current.forEach((voice) => stopVoice(voice, true));
    setSustainPressed(false);
    sustainRef.current = false;
  }, [stopVoice]);

  const setSustain = useCallback(
    (pressed: boolean) => {
      sustainRef.current = pressed;
      setSustainPressed(pressed);
      if (pressed) {
        voicesRef.current.forEach((voice) => {
          if (voice.sampleState) triggerSampleTail(voice);
        });
      } else {
        voicesRef.current.forEach((voice) => {
          if (voice.released && (!voice.sampleState || voice.sampleState.sustainLatched)) {
            stopVoice(voice, true);
          }
        });
      }
    },
    [stopVoice, triggerSampleTail],
  );

  const sideAndOffsetForCode = useCallback((code: string) => {
    const current = settingsRef.current;
    const leftIndex = current.leftMapping.indexOf(code);
    if (leftIndex >= 0) return { side: "left" as const, offset: NOTE_OFFSETS[leftIndex] };
    if (current.keyboardCount === 2) {
      const rightIndex = current.rightMapping.indexOf(code);
      if (rightIndex >= 0) return { side: "right" as const, offset: NOTE_OFFSETS[rightIndex] };
    }
    return null;
  }, []);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = captureRef.current;
      if (target) {
        event.preventDefault();
        if (event.code === "Escape") {
          setCaptureTarget(null);
          setMappingError("");
          return;
        }
        const current = settingsRef.current;
        const allCodes = [
          ...current.leftMapping,
          ...current.rightMapping,
          ...current.octaveShortcuts,
          ...Object.values(current.transposeShortcuts),
          "Space",
        ];
        const oldCode = target.kind === "note"
          ? (target.side === "left" ? current.leftMapping[target.index] : current.rightMapping[target.index])
          : target.kind === "octave"
            ? current.octaveShortcuts[target.index]
            : current.transposeShortcuts[target.action];
        if (allCodes.includes(event.code) && event.code !== oldCode) {
          setMappingError(t("{key} 키는 이미 다른 기능에 사용 중입니다.", { key: codeLabel(event.code) }));
          return;
        }
        if (target.kind === "note") {
          const key = target.side === "left" ? "leftMapping" : "rightMapping";
          const next = [...current[key]];
          next[target.index] = event.code;
          updateSettings({ [key]: next } as Partial<Settings>);
        } else if (target.kind === "octave") {
          const next = [...current.octaveShortcuts];
          next[target.index] = event.code;
          updateSettings({ octaveShortcuts: next });
        } else {
          updateSettings({
            transposeShortcuts: { ...current.transposeShortcuts, [target.action]: event.code },
          });
        }
        setCaptureTarget(null);
        setMappingError("");
        return;
      }
      if (mmlOpen && event.code === "Space") return;
      if (isTypingTarget(event.target) || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const current = settingsRef.current;
      const octaveShortcutIndex = current.octaveShortcuts.indexOf(event.code);
      if (octaveShortcutIndex >= 0) {
        event.preventDefault();
        if (octaveShortcutIndex < 4) {
          setLeftOctave(current.leftOctavePresets[octaveShortcutIndex]);
        } else if (current.keyboardCount === 2) {
          setRightOctave(current.rightOctavePresets[octaveShortcutIndex - 4]);
        }
        return;
      }
      const transposeAction = (Object.keys(current.transposeShortcuts) as TransposeShortcutAction[])
        .find((action) => current.transposeShortcuts[action] === event.code);
      if (transposeAction) {
        event.preventDefault();
        if (transposeAction === "downSemitone") setTranspose((value) => value - 1);
        if (transposeAction === "upSemitone") setTranspose((value) => value + 1);
        if (transposeAction === "downFifth") setTranspose((value) => value - 7);
        if (transposeAction === "upFifth") setTranspose((value) => value + 7);
        if (transposeAction === "reset") {
          allNotesOff();
          setTranspose(0);
        }
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        setSustain(true);
        return;
      }
      const mapped = sideAndOffsetForCode(event.code);
      if (!mapped) return;
      event.preventDefault();
      void startNote(`keyboard:${event.code}`, mapped.side, mapped.offset, { recordingAt: inputEventSeconds(event) });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (mmlOpen && event.code === "Space") return;
      if (event.code === "Space") {
        event.preventDefault();
        setSustain(false);
        return;
      }
      releaseInput(`keyboard:${event.code}`, false, inputEventSeconds(event));
    };

    const handleBlur = () => allNotesOff();
    const handleVisibility = () => {
      if (document.hidden) allNotesOff();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [allNotesOff, mmlOpen, releaseInput, setSustain, sideAndOffsetForCode, startNote, t, updateSettings]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, side: KeyboardSide, offset: number) => {
      event.preventDefault();
      const inputId = `pointer:${event.pointerId}`;
      const keyId = `${side}:${offset}`;
      activePointersRef.current.set(event.pointerId, keyId);
      void startNote(inputId, side, offset, { recordingAt: inputEventSeconds(event) });
    },
    [startNote],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!activePointersRef.current.has(event.pointerId)) return;
      event.preventDefault();
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-piano-key]");
      const inputId = `pointer:${event.pointerId}`;
      if (!element) {
        releaseInput(inputId, false, inputEventSeconds(event));
        activePointersRef.current.set(event.pointerId, "");
        return;
      }
      const keyId = element.dataset.pianoKey ?? "";
      if (activePointersRef.current.get(event.pointerId) === keyId) return;
      const side = element.dataset.side as KeyboardSide;
      const offset = Number(element.dataset.offset);
      activePointersRef.current.set(event.pointerId, keyId);
      void startNote(inputId, side, offset, { recordingAt: inputEventSeconds(event) });
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (!activePointersRef.current.has(event.pointerId)) return;
      releaseInput(`pointer:${event.pointerId}`, false, inputEventSeconds(event));
      activePointersRef.current.delete(event.pointerId);
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [releaseInput, startNote]);

  const selectTheme = useCallback(
    (themeId: string) => {
      allNotesOff();
      updateSettings({ themeId });
    },
    [allNotesOff, updateSettings],
  );

  const importSoundPack = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSoundPackBusy(true);
    setSoundPackStatus(t("사운드팩을 확인하는 중입니다…"));
    try {
      const pack = await parseSoundPackFile(file);
      allNotesOff();
      disposeSoundPackSynth();
      soundPackRef.current = pack;
      setSoundPack(pack);
      updateSettings({ themeId: pack.presets[0].id });
      try {
        await saveStoredSoundPack(pack);
        setSoundPackStatus(t("이 기기에 저장했습니다."));
      } catch {
        setSoundPackStatus(t("사운드팩을 열었지만 기기 저장 공간이 부족해 이번 접속에서만 사용할 수 있습니다."));
      }
      try {
        await ensureSoundPackSynth(initAudio());
      } catch (error) {
        setSoundPackStatus(t(error instanceof Error ? error.message : "사운드팩을 재생할 준비를 하지 못했습니다."));
      }
    } catch (error) {
      setSoundPackStatus(t(error instanceof Error ? error.message : "사운드팩을 추가하지 못했습니다."));
    } finally {
      setSoundPackBusy(false);
    }
  }, [allNotesOff, disposeSoundPackSynth, ensureSoundPackSynth, initAudio, t, updateSettings]);

  const removeSoundPack = useCallback(async () => {
    if (!window.confirm(t("이 기기에 저장된 사운드팩을 삭제할까요?"))) return;
    allNotesOff();
    disposeSoundPackSynth();
    soundPackRef.current = null;
    setSoundPack(null);
    if (parseSoundPackThemeId(settingsRef.current.themeId)) updateSettings({ themeId: DEFAULT_SETTINGS.themeId });
    try {
      await deleteStoredSoundPack();
      setSoundPackStatus(t("기기에서 사운드팩을 삭제했습니다."));
    } catch {
      setSoundPackStatus(t("사운드팩 저장 정보를 삭제하지 못했습니다."));
    }
  }, [allNotesOff, disposeSoundPackSynth, t, updateSettings]);

  const updatePreset = useCallback(
    (side: KeyboardSide, index: number, value: number) => {
      const nextValue = Math.max(0, Math.min(8, Math.round(value)));
      setSettings((current) => {
        const key = side === "left" ? "leftOctavePresets" : "rightOctavePresets";
        const previousValue = current[key][index];
        const next = [...current[key]] as Settings["leftOctavePresets"];
        next[index] = nextValue;
        if (side === "left" && leftOctaveRef.current === previousValue) setLeftOctave(nextValue);
        if (side === "right" && rightOctaveRef.current === previousValue) setRightOctave(nextValue);
        return { ...current, [key]: next };
      });
    },
    [],
  );

  const resetSettings = useCallback(() => {
    if (!window.confirm(t("모든 설정을 기본값으로 되돌릴까요?"))) return;
    allNotesOff();
    window.localStorage.removeItem(STORAGE_KEY);
    setSettings(DEFAULT_SETTINGS);
    setLeftOctave(4);
    setRightOctave(5);
    setTranspose(0);
    setLastCatPitchClass(11);
    setMouthOpen(false);
    setMappingError("");
    setCaptureTarget(null);
  }, [allNotesOff, t]);

  const resetTranspose = useCallback(() => {
    allNotesOff();
    setTranspose(0);
  }, [allNotesOff]);

  const registerMmlInputSink = useCallback((sink: MmlInputSink | null) => {
    mmlInputSinkRef.current = sink;
  }, []);

  const getMmlTrackOutput = useCallback((trackId: string) => {
    const graph = initAudio();
    const existing = mmlTrackGainRef.current.get(trackId);
    if (existing) return existing;
    const gain = graph.context.createGain();
    const mix = mmlTrackMixRef.current.get(trackId);
    gain.gain.value = mix && mix.audible ? mix.volume : 0;
    gain.connect(graph.master);
    mmlTrackGainRef.current.set(trackId, gain);
    return gain;
  }, [initAudio]);

  const syncMmlTrackMix = useCallback((states: MmlTrackMixState[]) => {
    const next = new Map(states.map((state) => [state.trackId, state]));
    mmlTrackMixRef.current = next;
    const graph = audioRef.current;
    if (graph) {
      mmlTrackGainRef.current.forEach((gain, trackId) => {
        const state = next.get(trackId);
        if (!state) {
          gain.disconnect();
          mmlTrackGainRef.current.delete(trackId);
          return;
        }
        const now = graph.context.currentTime;
        const target = state.audible ? state.volume : 0;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(target, now + 0.005);
      });
    }
    const loaded = soundPackSynthRef.current;
    if (loaded) {
      const at = graph?.context.currentTime;
      states.forEach((state) => {
        const channel = loaded.channelByTheme.get(`${state.themeId}:${state.trackId}`);
        if (channel === undefined) return;
        loaded.synth.controllerChange(channel, 7, Math.round(127 * (state.audible ? state.volume : 0)), at === undefined ? undefined : { time: at });
      });
    }
  }, []);

  const playMmlMidi = useCallback((sourceId: string, midi: number, themeId: string, volume: number, trackId: string, delaySeconds = 0) => {
    void startNote(sourceId, "left", 0, {
      soundingMidi: midi,
      themeId,
      volume,
      keyId: `mml:${midi}`,
      skipRecording: true,
      audioDelaySeconds: delaySeconds,
      mmlTrackId: trackId,
      outputNode: getMmlTrackOutput(trackId),
    });
  }, [getMmlTrackOutput, startNote]);

  const prepareMmlThemes = useCallback(async (themeIds: string[]) => {
    const graph = initAudio();
    const uniqueThemeIds = [...new Set(themeIds)];
    const soundPackThemeIds = uniqueThemeIds.filter((themeId) => parseSoundPackThemeId(themeId));
    const tasks: Promise<unknown>[] = [];

    if (uniqueThemeIds.includes("nyang-voice")) {
      tasks.push(loadSampleBuffer(graph.context, NYANG_SAMPLE.url));
    }
    if (soundPackThemeIds.length > 0) {
      tasks.push(ensureSoundPackSynth(graph).then((loaded) => {
        const at = graph.context.currentTime;
        soundPackThemeIds.forEach((themeId) => soundPackChannel(loaded, themeId, at));
      }));
    }
    await Promise.all(tasks);
  }, [ensureSoundPackSynth, initAudio, loadSampleBuffer, soundPackChannel]);

  const releaseMmlMidi = useCallback((sourceId: string) => {
    releaseInput(sourceId, true);
  }, [releaseInput]);

  const stopMmlAudio = useCallback(() => {
    [...pendingNoteRef.current.keys()]
      .filter((inputId) => inputId.startsWith("mml:"))
      .forEach((inputId) => pendingNoteRef.current.delete(inputId));
    [...voicesRef.current.values()]
      .filter((voice) => voice.inputId.startsWith("mml:"))
      .forEach((voice) => {
        inputVoiceRef.current.delete(voice.inputId);
        voice.released = true;
        stopVoice(voice, true);
      });
  }, [stopVoice]);

  const clickMetronome = useCallback((accented: boolean, volume: number, delaySeconds = 0, preparing = false) => {
    const graph = initAudio();
    const now = graph.context.currentTime + Math.max(0, delaySeconds);
    const oscillator = graph.context.createOscillator();
    const gain = graph.context.createGain();
    oscillator.type = preparing ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(preparing ? (accented ? 1760 : 1480) : (accented ? 1320 : 880), now);
    gain.gain.setValueAtTime(Math.max(0.0001, volume * (preparing ? 0.17 : 0.12)), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (preparing ? 0.075 : 0.045));
    oscillator.connect(gain);
    gain.connect(graph.master);
    oscillator.start(now);
    oscillator.stop(now + (preparing ? 0.09 : 0.055));
    let active = true;
    const disconnect = () => {
      if (!active) return;
      active = false;
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.onended = disconnect;
    return () => {
      if (!active) return;
      try {
        oscillator.stop(graph.context.currentTime);
      } catch {
        // The click may already have ended.
      }
      disconnect();
    };
  }, [initAudio]);

  const openMml = useCallback(() => {
    setSustain(false);
    setMmlOpen(true);
  }, [setSustain]);

  const closeMml = useCallback(() => {
    setMmlExpanded(false);
    setMmlOpen(false);
  }, []);

  useEffect(() => {
    const handleMmlShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyM") return;
      const typing = Boolean((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']"));
      if (typing) return;
      event.preventDefault();
      if (mmlOpen) {
        closeMml();
      }
      else openMml();
    };
    window.addEventListener("keydown", handleMmlShortcut);
    return () => window.removeEventListener("keydown", handleMmlShortcut);
  }, [closeMml, mmlOpen, openMml]);

  const segmentCount = 11 - lastCatPitchClass;
  const currentKey = noteName(transpose, settings.accidentalStyle);
  const catNote = noteName(lastCatPitchClass, settings.accidentalStyle);
  const appStyle = {
    "--accent": theme.accent,
    "--accent-soft": theme.accentSoft,
    "--key-accent": theme.keyAccent,
  } as CSSProperties;

  const renderOctavePanel = (side: KeyboardSide) => {
    const selected = side === "left" ? leftOctave : rightOctave;
    const setter = side === "left" ? setLeftOctave : setRightOctave;
    const presets = side === "left" ? settings.leftOctavePresets : settings.rightOctavePresets;
    const shortcutOffset = side === "left" ? 0 : 4;
    const panelTitle = side === "left" ? "OCT L" : "OCT R";
    return (
      <section className="octave-panel" aria-label={`${t(side === "left" ? "왼쪽" : "오른쪽")} ${t("옥타브 선택")}`}>
        <div className="panel-eyebrow">{panelTitle}</div>
        <div className="octave-buttons">
          {presets.map((octave, index) => (
            <button
              type="button"
              className={`control-button octave-button ${selected === octave ? "is-selected" : ""}`}
              key={`${side}-${index}-${octave}`}
              onClick={() => setter(octave)}
              aria-pressed={selected === octave}
            >
              <span>O</span>{octave}
              <kbd className="control-shortcut octave-shortcut">
                {codeLabel(settings.octaveShortcuts[shortcutOffset + index])}
              </kbd>
            </button>
          ))}
        </div>
      </section>
    );
  };

  const mappingEditor = (side: KeyboardSide) => {
    const mapping = side === "left" ? settings.leftMapping : settings.rightMapping;
    return (
      <div className="mapping-editor">
        {NOTE_OFFSETS.map((offset, index) => {
          const isCapture = captureTarget?.kind === "note" && captureTarget.side === side && captureTarget.index === index;
          return (
            <button
              type="button"
              className={`mapping-chip ${isCapture ? "is-capturing" : ""}`}
              key={`${side}-map-${offset}`}
              onClick={() => {
                setCaptureTarget({ kind: "note", side, index });
                setMappingError("");
              }}
            >
              <span>{noteName(offset, settings.accidentalStyle)}</span>
              <strong>{isCapture ? t("키 입력…") : codeLabel(mapping[index])}</strong>
            </button>
          );
        })}
      </div>
    );
  };

  const shortcutEditor = () => (
    <div className="shortcut-settings">
      <div className="shortcut-group">
        <h4>{t("옥타브 선택")}</h4>
        <p>{t("왼쪽 F1–F4 · 오른쪽 F5–F8")}</p>
        <div className="shortcut-grid octave-shortcut-grid">
          {settings.octaveShortcuts.map((code, index) => {
            const isCapture = captureTarget?.kind === "octave" && captureTarget.index === index;
            const side = t(index < 4 ? "왼쪽" : "오른쪽");
            const octave = index < 4
              ? settings.leftOctavePresets[index]
              : settings.rightOctavePresets[index - 4];
            return (
              <button
                type="button"
                className={`mapping-chip shortcut-chip ${isCapture ? "is-capturing" : ""}`}
                key={`octave-shortcut-${index}`}
                onClick={() => {
                  setCaptureTarget({ kind: "octave", index });
                  setMappingError("");
                }}
              >
                <span>{side} O{octave}</span>
                <strong>{isCapture ? t("키 입력…") : codeLabel(code)}</strong>
              </button>
            );
          })}
        </div>
      </div>
      <div className="shortcut-group">
        <h4>{t("이조")}</h4>
        <div className="shortcut-grid transpose-shortcut-grid">
          {(Object.keys(TRANSPOSE_SHORTCUT_LABELS) as TransposeShortcutAction[]).map((action) => {
            const isCapture = captureTarget?.kind === "transpose" && captureTarget.action === action;
            return (
              <button
                type="button"
                className={`mapping-chip shortcut-chip ${isCapture ? "is-capturing" : ""}`}
                key={`transpose-shortcut-${action}`}
                onClick={() => {
                  setCaptureTarget({ kind: "transpose", action });
                  setMappingError("");
                }}
              >
                <span>{t(TRANSPOSE_SHORTCUT_LABELS[action])}</span>
                <strong>{isCapture ? t("키 입력…") : codeLabel(settings.transposeShortcuts[action])}</strong>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <main className={`app-viewport ${settings.mobileLandscape ? "force-mobile-landscape" : ""} ${mmlOpen ? "mml-open" : ""} ${mmlExpanded ? "mml-expanded" : ""}`} style={appStyle} onContextMenu={(event) => event.preventDefault()}>
      <div className="app-stage">
        <MmlStudio
          currentThemeId={settings.themeId}
          themes={availableThemes}
          visible={mmlOpen}
          expanded={mmlExpanded}
          onExpandedChange={setMmlExpanded}
          onClose={closeMml}
          registerInputSink={registerMmlInputSink}
          prepareThemes={prepareMmlThemes}
          playMidi={playMmlMidi}
          releaseMidi={releaseMmlMidi}
          stopMmlAudio={stopMmlAudio}
          syncTrackMix={syncMmlTrackMix}
          clickMetronome={clickMetronome}
          onPlayShortcutChange={setMmlPlayShortcut}
          onRestShortcutChange={setMmlRestShortcut}
          onRestPressedChange={setMmlRestPressed}
        />
        <div className="performance-surface">
        <header className={`top-bar ${settings.keyboardCount === 2 ? "has-double-keyboard" : ""}`}>
          <div className="brand-block">
            <button
              type="button"
              className={`brand-mark ${mmlOpen ? "is-mml-open" : ""}`}
              onClick={() => { if (mmlOpen) closeMml(); else openMml(); }}
              aria-label={t(mmlOpen ? "MML 편집창 닫기" : "MML 편집창 열기")}
              aria-pressed={mmlOpen}
              title={t(mmlOpen ? "MML 편집창 닫기 · Alt+M" : "MML 편집창 열기 · Alt+M")}
            >
              <img src={theme.visuals.pawPad} alt="" />
              <span className="brand-mark-mml" aria-hidden="true">MML</span>
            </button>
            <div>
              <h1>{brandName}</h1>
            </div>
          </div>

          <div className={`octave-area ${settings.keyboardCount === 2 ? "is-double" : ""}`}>
            {renderOctavePanel("left")}
            {settings.keyboardCount === 2 && renderOctavePanel("right")}
          </div>

          <section className="transpose-panel" aria-label={t("전조 조절")}>
            <div className="transpose-status">
              <span>KEY</span>
              <strong>{currentKey}</strong>
              <small>{transpose > 0 ? `+${transpose}` : transpose} ST</small>
            </div>
            <div className="transpose-grid">
              <button type="button" className="control-button transpose-command" onClick={() => setTranspose((value) => value - 1)}>
                <span>−1</span><small>{t("반음")}</small>
                <kbd className="control-shortcut">{codeLabel(settings.transposeShortcuts.downSemitone)}</kbd>
              </button>
              <button type="button" className="control-button transpose-command" onClick={() => setTranspose((value) => value + 1)}>
                <span>+1</span><small>{t("반음")}</small>
                <kbd className="control-shortcut">{codeLabel(settings.transposeShortcuts.upSemitone)}</kbd>
              </button>
              <button type="button" className="control-button transpose-command" onClick={() => setTranspose((value) => value - 7)}>
                <span>−5th</span><small>{t("완전5도")}</small>
                <kbd className="control-shortcut">{codeLabel(settings.transposeShortcuts.downFifth)}</kbd>
              </button>
              <button type="button" className="control-button transpose-command" onClick={() => setTranspose((value) => value + 7)}>
                <span>+5th</span><small>{t("완전5도")}</small>
                <kbd className="control-shortcut">{codeLabel(settings.transposeShortcuts.upFifth)}</kbd>
              </button>
            </div>
            <button type="button" className="transpose-reset control-button" onClick={resetTranspose} aria-label={t("조성을 C로 초기화")}>
              <RotateCcw className="reset-icon" aria-hidden="true" />
              <small>{t("초기화")}</small>
              <kbd className="control-shortcut">{codeLabel(settings.transposeShortcuts.reset)}</kbd>
            </button>
          </section>

          <div className="header-actions">
            <button type="button" className="settings-button" onClick={() => setSettingsOpen(true)} aria-label={t("설정 열기")}>
              <SettingsIcon className="settings-icon" aria-hidden="true" />
              {t("설정")}
            </button>
          </div>
        </header>

        <section className={`cat-zone ${settings.keyboardCount === 2 ? "is-double" : ""}`} aria-label={t("고양이 길이 {note}, {step}단계", { note: catNote, step: segmentCount + 1 })}>
          <div className="cat-track">
            <div className="cat-assembly" aria-hidden="true">
              <img className="cat-mouth" src={mouthOpen ? theme.visuals.mouthOpen : theme.visuals.mouthClosed} alt="" draggable={false} />
              {Array.from({ length: segmentCount }, (_, index) => (
                <img className="cat-middle" src={theme.visuals.bodyMiddle} alt="" draggable={false} key={`segment-${index}`} />
              ))}
              <img className="cat-end" src={theme.visuals.bodyEnd} alt="" draggable={false} />
            </div>
          </div>
        </section>

        <section className={`keyboard-deck ${settings.keyboardCount === 2 ? "is-double" : ""}`} aria-label={t("발바닥 음판")}>
          <KeyboardGroup
            side="left"
            octave={leftOctave}
            showSideLabel
            settings={settings}
            mapping={settings.leftMapping}
            transpose={transpose}
            activeKeys={activeKeys}
            pawPad={theme.visuals.pawPad}
            onPointerDown={handlePointerDown}
            restControl={mmlOpen ? {
              active: mmlRestPressed,
              shortcut: codeLabel(mmlRestShortcut),
              showNoteLabel: settings.noteLabelMode !== "hidden",
              showShortcut: settings.showKeyMapping,
              onPointerDown: (event) => {
                event.preventDefault();
                setMmlRestPressed(true);
                event.currentTarget.setPointerCapture(event.pointerId);
                mmlInputSinkRef.current?.restOn(inputEventSeconds(event));
              },
              onPointerUp: (event) => {
                event.preventDefault();
                setMmlRestPressed(false);
                mmlInputSinkRef.current?.restOff(inputEventSeconds(event));
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              },
              onPointerCancel: (event) => {
                setMmlRestPressed(false);
                mmlInputSinkRef.current?.restOff(inputEventSeconds(event));
              },
              onClick: () => {
                if (!mmlRestPressed) return;
                setMmlRestPressed(false);
                mmlInputSinkRef.current?.restOff(performance.now() / 1000);
              },
            } : undefined}
          />
          {settings.keyboardCount === 2 && (
            <KeyboardGroup
              side="right"
              octave={rightOctave}
              showSideLabel
              settings={settings}
              mapping={settings.rightMapping}
              transpose={transpose}
              activeKeys={activeKeys}
              pawPad={theme.visuals.pawPad}
              onPointerDown={handlePointerDown}
            />
          )}
        </section>

        <footer className="performance-footer">
          <span className={audioReady ? "is-ready" : ""}>{audioReady ? "● AUDIO READY" : t("첫 건반을 누르면 오디오가 시작됩니다")}</span>
          <span className={sustainPressed ? "sustain-on" : ""}>{mmlOpen ? `${shortcutCodeLabel(mmlPlayShortcut)} · ${t("재생/정지")}` : `SPACE · SUSTAIN ${sustainPressed ? "ON" : ""}`}</span>
          <button type="button" onClick={allNotesOff}>{t("모든 음 끄기")}</button>
        </footer>
        </div>
      </div>

      {settingsOpen && (
        <div className="settings-overlay" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSettingsOpen(false);
        }}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="settings-header">
              <div>
                <span>{brandName}</span>
                <h2 id="settings-title">{t("연주 설정")}</h2>
              </div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label={t("설정 닫기")}><X aria-hidden="true" /></button>
            </div>

            <div className="settings-content">
              <section className="settings-section language-settings-section">
                <div className="settings-section-title"><span aria-hidden="true"><Languages /></span><h3>{t("언어")}</h3></div>
                <div className="setting-field">
                  <label htmlFor="site-language">{t("언어")}</label>
                  <select id="site-language" value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                    {LOCALE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <p className="setting-note">{t("브라우저 언어를 기본으로 사용합니다.")}</p>
              </section>

              <section className="settings-section">
                <div className="settings-section-title"><span>01</span><h3>{t("건반과 옥타브")}</h3></div>
                <Toggle
                  checked={settings.keyboardCount === 2}
                  onChange={(checked) => {
                    if (checked) {
                      const rightPresets = settingsRef.current.rightOctavePresets;
                      setRightOctave(chooseSecondKeyboardOctave(rightPresets));
                    }
                    updateSettings({ keyboardCount: checked ? 2 : 1 });
                  }}
                  label={t("건반 한 세트 추가")}
                />
                <Toggle checked={settings.mobileLandscape} onChange={(checked) => updateSettings({ mobileLandscape: checked })} label={t("휴대폰 세로 화면을 가로로 표시")} />
                <div className="side-visibility-grid">
                  <div>
                    <strong>{t("왼쪽 건반")}</strong>
                    <Toggle checked={settings.leftShowLowerB} onChange={(checked) => updateSettings({ leftShowLowerB: checked })} label={t("낮은 B 표시")} />
                    <Toggle checked={settings.leftShowUpperC} onChange={(checked) => updateSettings({ leftShowUpperC: checked })} label={t("높은 C 표시")} />
                  </div>
                  <div>
                    <strong>{t("오른쪽 건반")}</strong>
                    <Toggle checked={settings.rightShowLowerB} onChange={(checked) => updateSettings({ rightShowLowerB: checked })} label={t("낮은 B 표시")} />
                    <Toggle checked={settings.rightShowUpperC} onChange={(checked) => updateSettings({ rightShowUpperC: checked })} label={t("높은 C 표시")} />
                  </div>
                </div>
                <div className="setting-field octave-preset-field">
                  <label>{t("왼쪽 옥타브 선택 버튼")}</label>
                  <div className="preset-inputs">
                    {settings.leftOctavePresets.map((value, index) => (
                      <OctavePresetInput key={`left-preset-${index}-${value}`} sideLabel={t("왼쪽")} index={index} value={value} onCommit={(next) => updatePreset("left", index, next)} />
                    ))}
                  </div>
                </div>
                <div className="setting-field octave-preset-field">
                  <label>{t("오른쪽 옥타브 선택 버튼")}</label>
                  <div className="preset-inputs">
                    {settings.rightOctavePresets.map((value, index) => (
                      <OctavePresetInput key={`right-preset-${index}-${value}`} sideLabel={t("오른쪽")} index={index} value={value} onCommit={(next) => updatePreset("right", index, next)} />
                    ))}
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title"><span>02</span><h3>{t("건반 표시")}</h3></div>
                <div className="setting-field">
                  <label htmlFor="note-label-mode">{t("음 이름")}</label>
                  <select id="note-label-mode" value={settings.noteLabelMode} onChange={(event) => updateSettings({ noteLabelMode: event.target.value as NoteLabelMode })}>
                    <option value="hidden">{t("표시하지 않음")}</option>
                    <option value="base">{t("건반의 기본 음")}</option>
                    <option value="transposed">{t("전조된 실제 음")}</option>
                  </select>
                </div>
                <div className="segmented-setting" aria-label={t("임시표 표기")}>
                  <button type="button" className={settings.accidentalStyle === "sharp" ? "is-selected" : ""} onClick={() => updateSettings({ accidentalStyle: "sharp" })}>{t("샵 ♯")}</button>
                  <button type="button" className={settings.accidentalStyle === "flat" ? "is-selected" : ""} onClick={() => updateSettings({ accidentalStyle: "flat" })}>{t("플랫 ♭")}</button>
                </div>
                <Toggle checked={settings.showKeyMapping} onChange={(checked) => updateSettings({ showKeyMapping: checked })} label={t("키 매핑 문자 표시")} />
              </section>

              <section className="settings-section">
                <div className="settings-section-title"><span>03</span><h3>{t("소리와 음색")}</h3></div>
                <div className="setting-field range-field">
                  <label>{t("전체 음량")} <strong>{Math.round(settings.masterVolume * 100)}%</strong></label>
                  <RangeControl id="master-volume" ariaLabel={t("전체 음량")} min={0} max={1} step={0.01} value={settings.masterVolume} onValueChange={(masterVolume) => updateSettings({ masterVolume })} />
                </div>
                <div className="theme-grid">
                  {THEMES.map((item) => (
                    <button type="button" className={settings.themeId === item.id ? "is-selected" : ""} key={item.id} onClick={() => selectTheme(item.id)}>
                      <i style={{ background: item.accent }} />
                      <span><strong>{t(item.name)}</strong><small>{t(item.description)}</small></span>
                    </button>
                  ))}
                </div>
                <div className="sound-pack-setting">
                  <div className="sound-pack-heading">
                    <div>
                      <strong>{t("음색 파일 추가")}</strong>
                      <small>{t("ZIP 또는 DLS 파일을 이 기기에서 불러옵니다")}</small>
                    </div>
                    <button
                      type="button"
                      className="sound-pack-add-button"
                      disabled={soundPackBusy}
                      onClick={() => soundPackInputRef.current?.click()}
                    >
                      {t(soundPack ? "다른 파일" : "파일 선택")}
                    </button>
                  </div>
                  <input
                    ref={soundPackInputRef}
                    className="sound-pack-file-input"
                    type="file"
                    accept=".zip,.dls,application/zip,application/octet-stream"
                    onChange={(event) => void importSoundPack(event)}
                  />
                  {soundPack && (
                    <div className="sound-pack-card">
                      <div className="sound-pack-info">
                        <strong>{soundPack.name}</strong>
                        <small>{soundPack.fileName} · {t("악기 {count}개", { count: soundPack.presets.length })}</small>
                      </div>
                      <label className="setting-field sound-pack-instrument-field">
                        <span>{t("사용할 악기")}</span>
                        <select
                          value={parseSoundPackThemeId(settings.themeId) ? settings.themeId : ""}
                          onChange={(event) => event.target.value && selectTheme(event.target.value)}
                        >
                          <option value="">{t("악기를 선택하세요")}</option>
                          {soundPack.presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="sound-pack-remove-button" onClick={() => void removeSoundPack()}>{t("기기에서 삭제")}</button>
                    </div>
                  )}
                  {soundPackStatus && <p className="sound-pack-status" role="status">{soundPackStatus}</p>}
                  <p className="setting-note">{t("선택한 파일은 서버로 전송하지 않습니다. 사운드팩의 이용 조건은 파일 제공처에서 확인해 주세요.")}</p>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title"><span>04</span><h3>{t("컴퓨터 키 매핑")}</h3></div>
                <p className="setting-note">{t("바꾸려는 키를 누른 다음 새 키를 입력하세요. 숨긴 건반의 매핑도 계속 작동합니다.")}</p>
                <details open>
                  <summary>{t("왼쪽 건반")}</summary>
                  {mappingEditor("left")}
                </details>
                <details>
                  <summary>{t("오른쪽 건반")}</summary>
                  {mappingEditor("right")}
                </details>
                {shortcutEditor()}
                {mappingError && <p className="error-message">{mappingError}</p>}
              </section>

              <section className="settings-section danger-section">
                <div><strong>{t("설정 초기화")}</strong><p>{t("저장된 설정을 지우고 기본값으로 돌아갑니다.")}</p></div>
                <button type="button" onClick={resetSettings}>{t("초기화")}</button>
              </section>

              <div className="settings-legal">
                <a href="?page=help" data-app-route>
                  <span>{t("도움말")}</span>
                  <ExternalLink aria-hidden="true" />
                </a>
                <a
                  href="https://docs.google.com/forms/d/e/1FAIpQLSfwJVXnlAzQoZKInD5pQS1K6r5pwHwpSWi8yC5cdNTJT_DiIw/viewform"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>{t("문의 / 버그 제보")}</span>
                  <ExternalLink aria-hidden="true" />
                </a>
                <a href="?page=privacy" data-app-route>
                  <span>{t("개인정보처리방침")}</span>
                  <ExternalLink aria-hidden="true" />
                </a>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
