import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { combineTracks, deleteTempoCommand, mergeTempoEvents, parseMmlDocument, parseTrack, serializeTrackEvents, sourceRangeAtTick, stripComments, tempoAtTick, tickToSeconds, transposeMmlText, transposeMmlTextRange, transposeMmlTextRangeWithSelection, upsertTempoCommand } from "../app/mml/core.js";
import { allocateInputs, appendLegatoContinuation, armedInputStartAt, closeShortLegatoOverlaps, countInBeats, elapsedSecondsToTicks, liveInputTicks, liveNotesEndTick, nextMetronomeBeatAt, quantizationGridTicks, quantizedInputsEndTick, quantizeInputs, recordingInputEndAt, recordingStartPlan, recordingToTrackTexts, resolveRecordingStartTick, snapTickToGrid, syncedPlaybackStartAt } from "../app/mml/recording.js";
import { applyMmlImport, createProject, importedMmlTitle, reorderProjectTrack, sanitizeProject, trackAudibilityPatch, trackMixStates } from "../app/mml/project.js";
import { adjacentMeasureTick, anchoredScrollOffset, buildMetronomeEvents, buildTimelineGrid, clampTimelineZoom, followTimelineScroll, normalizedWheelSteps, zoomPreviewPositionOffset, zoomPreviewTransform } from "../app/mml/timeline.js";
import { setSelectedMmlLength, shiftSelectedMmlLength } from "../app/mml/editing.js";
import { createProjectFromMmi, parseMmiDocument } from "../app/mml/mmi.js";
import { createMidiFile, createProjectFromMidi, midiFilename } from "../app/mml/midi.js";
import { decodeThreeMleFile, isThreeMleDocument, parseThreeMleDocument } from "../app/mml/three-mle.js";
import { expandMmlText, optimizeMmlText } from "../app/mml/optimization.js";
import { MIDIBuilder, MIDIMessageTypes } from "spessasynth_core";

test("clamps timeline zoom to a useful range", () => {
  assert.equal(clampTimelineZoom(0.1), 0.5);
  assert.equal(clampTimelineZoom(1.25), 1.25);
  assert.equal(clampTimelineZoom(9), 4);
});

test("uses an imported MML filename as the replacement project title", () => {
  assert.equal(importedMmlTitle("고양이 산책.mml"), "고양이 산책");
  assert.equal(importedMmlTitle("C:\\music\\저녁.TXT"), "저녁");
  assert.equal(importedMmlTitle("제목 없음"), "제목 없음");
});

test("changes the project title only when an imported MML file replaces the song", () => {
  const project = createProject();
  project.title = "기존 제목";
  const payload = { ranges: ["t120o4c4"], replacementTitle: "불러온 곡" };
  assert.equal(applyMmlImport(project, payload, "replace").title, "불러온 곡");
  assert.equal(applyMmlImport(project, payload, "append").title, "기존 제목");
  assert.equal(applyMmlImport(project, payload, "tracks").title, "기존 제목");
  assert.equal(applyMmlImport(project, payload, "selected").title, "기존 제목");
});

test("reorders tracks together with their keyboard routing order", () => {
  const project = createProject();
  project.routing = {
    left: [project.tracks[0].id, project.tracks[2].id],
    right: [project.tracks[0].id, project.tracks[1].id, project.tracks[2].id],
  };
  const [first, second, third] = project.tracks;
  reorderProjectTrack(project, third.id, first.id, "before");
  assert.deepEqual(project.tracks.map((track) => track.id), [third.id, first.id, second.id]);
  assert.deepEqual(project.routing.left, [third.id, first.id]);
  assert.deepEqual(project.routing.right, [third.id, first.id, second.id]);
  assert.equal(project.tracks[0].sourceText, third.sourceText);
});

test("keeps mute and solo mutually exclusive while deriving live track audibility", () => {
  assert.deepEqual(trackAudibilityPatch({ muted: false, solo: true }, "mute"), { muted: true, solo: false });
  assert.deepEqual(trackAudibilityPatch({ muted: true, solo: false }, "solo"), { solo: true, muted: false });

  const tracks = [
    { id: "one", themeId: "nyang-voice", mixerVolume: 0.6, muted: false, solo: false },
    { id: "two", themeId: "nyang-voice", mixerVolume: 0.8, muted: false, solo: true },
    { id: "three", themeId: "nyang-voice", mixerVolume: 1, muted: true, solo: false },
  ];
  assert.deepEqual(trackMixStates(tracks), [
    { trackId: "one", themeId: "nyang-voice", volume: 0.6, audible: false },
    { trackId: "two", themeId: "nyang-voice", volume: 0.8, audible: true },
    { trackId: "three", themeId: "nyang-voice", volume: 1, audible: false },
  ]);

  assert.deepEqual(trackMixStates([
    { id: "one", themeId: "nyang-voice", mixerVolume: 0.25, muted: false, solo: false },
    { id: "two", themeId: "nyang-voice", mixerVolume: 0.5, muted: true, solo: false },
    { id: "three", themeId: "nyang-voice", mixerVolume: 0.75, muted: false, solo: false },
  ]), [
    { trackId: "one", themeId: "nyang-voice", volume: 0.25, audible: true },
    { trackId: "two", themeId: "nyang-voice", volume: 0.5, audible: false },
    { trackId: "three", themeId: "nyang-voice", volume: 0.75, audible: true },
  ]);

  assert.deepEqual(trackMixStates([
    { id: "one", themeId: "nyang-voice", mixerVolume: 1, muted: false, solo: true },
    { id: "two", themeId: "nyang-voice", mixerVolume: 1, muted: false, solo: true },
    { id: "three", themeId: "nyang-voice", mixerVolume: 1, muted: false, solo: false },
  ]).map(({ trackId, audible }) => ({ trackId, audible })), [
    { trackId: "one", audible: true },
    { trackId: "two", audible: true },
    { trackId: "three", audible: false },
  ]);

  const contradictory = createProject();
  contradictory.tracks[0].muted = true;
  contradictory.tracks[0].solo = true;
  assert.deepEqual(
    { muted: sanitizeProject(contradictory).tracks[0].muted, solo: sanitizeProject(contradictory).tracks[0].solo },
    { muted: false, solo: true },
  );
});

test("imports wrapped 3MLE channel files without reading extension data as MML", () => {
  const source = `[Settings]\r
Encoding=ks_c_5601-1987\r
Title=남극 산책\r
Source=\r
Memo=\r
[Channel2]\r
v12o3g4\r
[Channel1]\r
t120o4l\r
8cdef\r
[3MLE EXTENSION]\r
/* DO NOT EDIT!! DATA VOID IF "3MLE EXTENSION" IS EDITED. */\r
c=123\r
d=not-mml`;
  assert.equal(isThreeMleDocument(source), true);
  const parsed = parseThreeMleDocument(source);
  assert.equal(parsed.title, "남극 산책");
  assert.deepEqual(parsed.channels.map((channel) => channel.name), ["Channel 1", "Channel 2"]);
  assert.deepEqual(parsed.channels.map((channel) => channel.sourceText), ["t120o4l8cdef", "v12o3g4"]);
  parsed.channels.forEach((channel) => assert.doesNotThrow(() => parseTrack(channel.sourceText)));

  const asciiEncoded = source.replace("Title=남극 산책", "Title=Antarctic walk");
  const decoded = decodeThreeMleFile(new TextEncoder().encode(asciiEncoded));
  assert.match(decoded, /Title=Antarctic walk/);
  const project = applyMmlImport(createProject(), {
    ranges: parsed.channels.map((channel) => channel.sourceText),
    trackNames: parsed.channels.map((channel) => channel.name),
    replacementTitle: parsed.title,
    importSource: { format: parsed.format },
  }, "replace");
  assert.equal(project.title, "남극 산책");
  assert.deepEqual(project.tracks.map((track) => track.name), ["Channel 1", "Channel 2"]);
  assert.equal(project.importSource.format, "3mle");
});

test("normalizes standard pixel, line, and page wheel movement without OS-specific deltas", () => {
  assert.equal(normalizedWheelSteps(12, 0), 0.1);
  assert.equal(normalizedWheelSteps(120, 0), 1);
  assert.equal(normalizedWheelSteps(3, 1), 1);
  assert.equal(normalizedWheelSteps(1, 2, 600), 2);
  assert.equal(normalizedWheelSteps(960, 0), 2);
  assert.equal(normalizedWheelSteps(-960, 0), -2);
});

test("keeps the content beneath the pointer fixed while zooming", () => {
  const baseScale = 1.25;
  const targetScale = 2;
  const pointerOffset = 220;
  const scrollBefore = 640;
  const contentPosition = (scrollBefore + pointerOffset) / baseScale;
  const preview = zoomPreviewTransform(contentPosition, baseScale, targetScale);
  const previewPosition = preview.origin + (contentPosition * baseScale - preview.origin) * preview.scale - scrollBefore;
  assert.equal(previewPosition, pointerOffset);
  const nextScroll = anchoredScrollOffset(contentPosition, targetScale, pointerOffset, 500, 3200);
  assert.equal(contentPosition * targetScale - nextScroll, pointerOffset);
  assert.equal(anchoredScrollOffset(10, 0.5, 200, 500, 2000), 0);
  assert.equal(anchoredScrollOffset(2000, 2, 100, 500, 2500), 2000);
});

test("keeps clamped timeline markers still while previewing zoom at the beginning", () => {
  assert.equal(zoomPreviewPositionOffset(0, 1, 2, 4), 0);
  assert.equal(zoomPreviewPositionOffset(1, 1, 2, 4), 0);
  assert.equal(zoomPreviewPositionOffset(2, 2, 3, 4), 2);
  assert.equal(zoomPreviewPositionOffset(96, 1, 1.5, 4), 48);
});

test("changes note and rest lengths only inside the selected MML text", () => {
  const source = "l8 c d+4. r16 n61 // c2";
  const result = setSelectedMmlLength(source, 3, source.indexOf(" n61"), 4, 0);
  assert.equal(result.source, "l8 c4 d+4 r4 n61 // c2");
  assert.equal(result.changed, 3);
  assert.equal(result.source.slice(result.selectionStart, result.selectionEnd), "c4 d+4 r4");
});

test("steps mixed selected MML lengths while preserving dots", () => {
  const shorter = shiftSelectedMmlLength("l4c8.d4r", 2, 8, 1);
  assert.equal(shorter.source, "l4c16.d8r8");
  const longer = shiftSelectedMmlLength(shorter.source, 2, shorter.source.length, -1);
  assert.equal(longer.source, "l4c8.d4r4");
});

test("uses append recording by default and migrates the previous default", () => {
  const project = createProject();
  assert.equal(project.recording.mode, "append");
  assert.equal(project.recording.startPosition, "playhead");
  assert.equal(project.recording.metronome, false);
  assert.equal(project.recording.shortcuts.play, "Space");
  assert.equal("tempoMap" in project, false);
  assert.equal("tempo" in project, false);
  assert.equal(parseTrack(project.tracks[0].sourceText).tempos[0].bpm, 120);
  assert.deepEqual(project.routing, { left: [project.tracks[0].id], right: [project.tracks[1].id] });
  const legacy = createProject();
  legacy.version = 1;
  legacy.recording.mode = "realtime";
  legacy.recording.metronome = true;
  assert.equal(sanitizeProject(legacy).recording.mode, "append");
  assert.equal(sanitizeProject(legacy).recording.metronome, false);

  const previousShortcut = createProject();
  previousShortcut.version = 5;
  previousShortcut.recording.shortcuts.play = "Alt+KeyP";
  assert.equal(sanitizeProject(previousShortcut).recording.shortcuts.play, "Space");

  const customShortcut = createProject();
  customShortcut.version = 5;
  customShortcut.recording.shortcuts.play = "Alt+Enter";
  assert.equal(sanitizeProject(customShortcut).recording.shortcuts.play, "Alt+Enter");
});

test("writes editable tempo changes into the active MML track and migrates old timeline metadata", () => {
  const merged = mergeTempoEvents(
    [{ tick: 0, bpm: 120 }, { tick: 384, bpm: 90 }],
    [{ tick: 384, bpm: 72 }, { tick: 768, bpm: 140 }],
    120,
  );
  assert.deepEqual(merged.map(({ tick, bpm }) => ({ tick, bpm })), [
    { tick: 0, bpm: 120 },
    { tick: 384, bpm: 72 },
    { tick: 768, bpm: 140 },
  ]);
  const changed = upsertTempoCommand("t120o4c1", 192, 72);
  assert.deepEqual(parseTrack(changed).tempos.map(({ tick, bpm }) => ({ tick, bpm })), [
    { tick: 0, bpm: 120 },
    { tick: 192, bpm: 72 },
  ]);
  assert.deepEqual(parseTrack(changed).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })), [
    { tick: 0, duration: 384, midi: 60 },
  ]);
  assert.equal(parseTrack(deleteTempoCommand(changed, 192)).tempos.length, 1);
  const legacy = createProject();
  legacy.version = 8;
  legacy.tempo = 120;
  legacy.tempoMap = [{ tick: 0, bpm: 120 }, { tick: 384, bpm: 72 }];
  const migrated = sanitizeProject(legacy);
  assert.equal("tempoMap" in migrated, false);
  assert.equal("tempo" in migrated, false);
  assert.equal(migrated.tracks.length, 3);
  assert.deepEqual(migrated.tracks.flatMap((track) => parseTrack(track.sourceText).tempos).map(({ tick, bpm }) => ({ tick, bpm })), [
    { tick: 0, bpm: 120 },
    { tick: 384, bpm: 72 },
  ]);
  const previousRelease = createProject();
  previousRelease.version = 9;
  previousRelease.tracks.push({
    ...previousRelease.tracks[2],
    id: "old-tempo-track",
    name: "Tempo",
    sourceText: "r2t88",
    mmlRole: "tempo",
  });
  const mergedRelease = sanitizeProject(previousRelease);
  assert.equal(mergedRelease.tracks.some((track) => track.mmlRole === "tempo"), false);
  assert.equal(parseTrack(mergedRelease.tracks[0].sourceText).tempos.some((event) => event.tick === 192 && event.bpm === 88), true);
});

test("resolves recording start from the playhead, beginning, or routed tracks' empty end", () => {
  const durations = [384, 960, 192];
  assert.equal(resolveRecordingStartTick("playhead", 432, durations, [0, 1]), 432);
  assert.equal(resolveRecordingStartTick("beginning", 432, durations, [0, 1]), 0);
  assert.equal(resolveRecordingStartTick("empty", 432, durations, [0, 2]), 384);
  assert.equal(resolveRecordingStartTick("empty", 432, durations, [0, 1]), 960);
});

test("converts append recording time through tempo changes at the recording position", () => {
  const tempos = [{ tick: 0, bpm: 120 }, { tick: 96, bpm: 60 }];
  assert.ok(Math.abs(elapsedSecondsToTicks(48, 0.5, tempos, 120) - 72) < 0.001);
  assert.ok(Math.abs(elapsedSecondsToTicks(96, 1, tempos, 120) - 96) < 0.001);
  assert.ok(Math.abs(elapsedSecondsToTicks(0, 0.5, tempos, 120) - 96) < 0.001);
});

test("locates the active MML note or rest in source text during playback", () => {
  const source = "t120o4c4r8d8&d8";
  const track = parseTrack(source);
  assert.deepEqual(sourceRangeAtTick(track, 0), { start: 6, end: 8 });
  assert.deepEqual(sourceRangeAtTick(track, 96), { start: 8, end: 10 });
  assert.deepEqual(sourceRangeAtTick(track, 144), { start: 10, end: 15 });
  assert.equal(sourceRangeAtTick(track, track.duration), null);
});

test("uses the whole song as the default repeat range and migrates the old one-measure default", () => {
  const project = createProject();
  assert.equal(project.view.loopStart, 0);
  assert.equal(project.view.loopEnd, 0);

  const legacyDefault = createProject();
  legacyDefault.version = 4;
  legacyDefault.view.loopStart = 0;
  legacyDefault.view.loopEnd = 384;
  assert.equal(sanitizeProject(legacyDefault).view.loopEnd, 0);

  const legacyCustom = createProject();
  legacyCustom.version = 4;
  legacyCustom.view.loopStart = 384;
  legacyCustom.view.loopEnd = 768;
  assert.deepEqual(sanitizeProject(legacyCustom).view, legacyCustom.view);
});

test("migrates only the previous untouched default track routing", () => {
  const previous = createProject();
  previous.version = 3;
  previous.routing = {
    left: [previous.tracks[0].id, previous.tracks[1].id],
    right: [previous.tracks[2].id],
  };
  const migrated = sanitizeProject(previous);
  assert.deepEqual(migrated.routing, { left: [migrated.tracks[0].id], right: [migrated.tracks[1].id] });

  const custom = createProject();
  custom.version = 3;
  custom.routing = { left: [custom.tracks[2].id], right: [] };
  assert.deepEqual(sanitizeProject(custom).routing, custom.routing);
});

test("grows an active note graphic continuously before note-off", () => {
  const input = { startedAt: 10.25 };
  assert.deepEqual(liveInputTicks(input, 10.75, 120, 10, 96), { tick: 144, duration: 96 });
  assert.deepEqual(liveInputTicks(input, 11, 120, 10, 96), { tick: 144, duration: 144 });
});

test("starts append immediately while real-time recording can arm for the next metronome beat", () => {
  const clock = { startAt: 10, beatSeconds: 0.5 };
  assert.equal(nextMetronomeBeatAt(clock, 10.2), 10.5);
  assert.deepEqual(recordingStartPlan({
    mode: "append",
    countIn: 2,
    now: 10.2,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    metronomeClock: clock,
  }), { plannedStart: 10.2, waitsForStart: false });
  assert.deepEqual(recordingStartPlan({
    mode: "realtime",
    countIn: 0,
    now: 10.2,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    metronomeClock: clock,
  }), { plannedStart: 10.5, waitsForStart: true });
  assert.equal(armedInputStartAt("realtime", 10.5, 10.45), 10.5);
  assert.equal(armedInputStartAt("realtime", 10.5, 10.55), 10.55);
  assert.equal(recordingInputEndAt("append", 21.25, 3, 20.5), 3.75);
  assert.equal(recordingInputEndAt("realtime", 21.25, 3, 20.5), 21.25);
});

test("starts playback when the running metronome reaches the matching song beat", () => {
  const clock = { startAt: 10, beatSeconds: 0.5 };
  const meter = { numerator: 4, denominator: 4 };
  assert.equal(syncedPlaybackStartAt(true, clock, 10.2, { startTick: 0, timeSignature: meter }), 12);
  assert.equal(syncedPlaybackStartAt(true, clock, 10.2, { startTick: 96, timeSignature: meter }), 10.5);
  assert.equal(syncedPlaybackStartAt(true, clock, 10.2, { startTick: 48, timeSignature: meter }), 10.25);
  assert.equal(syncedPlaybackStartAt(true, clock, 10.49, { startTick: 96, timeSignature: meter }), 12.5);
  assert.equal(syncedPlaybackStartAt(true, clock, 10.2, { startTick: 480, meterStartTick: 384, timeSignature: meter }), 10.5);
  assert.equal(syncedPlaybackStartAt(false, clock, 10.2), 10.2);
  assert.equal(syncedPlaybackStartAt(true, null, 10.2), 10.2);
});

test("builds a full count-in measure with a distinct downbeat", () => {
  assert.deepEqual(countInBeats(12, 120, { numerator: 4, denominator: 4 }, 1), [
    { at: 10, beat: 0, count: 4, accent: true },
    { at: 10.5, beat: 1, count: 4, accent: false },
    { at: 11, beat: 2, count: 4, accent: false },
    { at: 11.5, beat: 3, count: 4, accent: false },
  ]);
});

test("parses Mabinogi-style notes, commands, dotted lengths, ties and absolute notes", () => {
  const parsed = parseTrack("t120o3l8v15c+4.d8&d8n61r4");
  assert.equal(parsed.tempos[0].bpm, 120);
  assert.equal(parsed.notes[0].midi, 49);
  assert.equal(parsed.notes[0].duration, 144);
  assert.equal(parsed.notes[1].duration, 96);
  assert.equal(parsed.notes[2].midi, 73);
  assert.equal(parsed.duration, 384);
});

test("maps Mabinogi absolute note numbers to the same pitch as named notes", () => {
  const named = parseTrack("o4c").notes[0];
  const absolute = parseTrack("n48").notes[0];
  assert.equal(named.midi, 60);
  assert.equal(absolute.midi, named.midi);
});

test("applies a dotted default length declared by the l command", () => {
  const parsed = parseTrack("l2.cde4f");
  assert.deepEqual(parsed.notes.map((note) => note.duration), [288, 288, 96, 288]);
});

test("parses a long three-track Mabinogi MML document with dotted default lengths", () => {
  const source = readFileSync(new URL("./fixtures/complex-three-track.mml", import.meta.url), "utf8").trim();
  const parsed = parseMmlDocument(source);
  assert.equal(parsed.tracks.length, 3);
  assert.deepEqual(parsed.tracks.map((track) => track.notes.length), [240, 218, 65]);
  assert.equal(parsed.duration, 18720);
});

test("preserves source positions and splits combined MML tracks", () => {
  const source = "MML@o4c4,/* keep */o3e4,g4;";
  const parsed = parseMmlDocument(source);
  assert.equal(parsed.tracks.length, 3);
  assert.equal(source.slice(parsed.tracks[1].notes[0].sourceStart, parsed.tracks[1].notes[0].sourceEnd), "e4");
  assert.equal(stripComments("c4 // hi\nd4/*x*/"), "c4      \nd4     ");
});

test("combines tracks and removes comments only for raw MML export", () => {
  assert.equal(combineTracks(["o4c4 // memo", "o3e4"], { removeComments: true }), "MML@o4c4,o3e4;");
});

test("optimizes MML text with the shortest useful default lengths without changing the performance", () => {
  const source = `/* intro */ T120 O4 L8 V15
    C D E F G A B > C T120 V15 O5 R8 R8`;
  const result = optimizeMmlText(source);
  assert.ok(result.source.length <= "t120o4v15l8cdefgab>crr".length);
  assert.ok(result.afterLength < result.beforeLength);
  const before = parseTrack(source);
  const after = parseTrack(result.source);
  assert.deepEqual(
    after.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    before.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
  );
  assert.deepEqual(after.rests.map(({ tick, duration }) => ({ tick, duration })), before.rests.map(({ tick, duration }) => ({ tick, duration })));
});

test("does not emit double-dotted notes that Mabinogi Mobile rejects", () => {
  const source = "t152v15e2.&e8";
  const optimized = optimizeMmlText(source);
  assert.equal(optimized.source.includes(".."), false);
  assert.match(optimized.source, /e2\.&e8/);
  assert.deepEqual(
    parseTrack(optimized.source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    parseTrack(source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
  );

  const repaired = optimizeMmlText("t152v15e2..");
  assert.equal(repaired.source.includes(".."), false);
  assert.match(repaired.source, /&/);
  assert.deepEqual(
    parseTrack(repaired.source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    parseTrack("t152v15e2..").notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
  );
});

test("optimizes absolute notes and restores compact MML as readable named notes", () => {
  const original = "// memo\nl16 n61 n63 l4. c4. r4.";
  const optimized = optimizeMmlText(original);
  assert.deepEqual(parseTrack(optimized.source).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })), parseTrack(original).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })));
  const restored = expandMmlText(optimized.source);
  assert.equal(/n[0-9]/.test(restored.source), false);
  assert.equal(restored.source.includes(" "), false);
  assert.deepEqual(
    parseTrack(restored.source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    parseTrack(optimized.source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
  );
  assert.equal(parseTrack(restored.source).duration, parseTrack(optimized.source).duration);
});

test("transposes the MML text itself while preserving timing, tempo, volume, ties, and comments", () => {
  const source = "// melody\nt152v12o3l8b>c+4&c+4r8n46";
  const shifted = transposeMmlText(source, 1);
  const before = parseTrack(source);
  const after = parseTrack(shifted);
  assert.match(shifted, /\/\/ melody/);
  assert.equal(shifted.includes("n46"), false);
  assert.deepEqual(
    after.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    before.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi: midi + 1, velocity })),
  );
  assert.deepEqual(after.tempos.map(({ tick, bpm }) => ({ tick, bpm })), before.tempos.map(({ tick, bpm }) => ({ tick, bpm })));
  assert.equal(after.duration, before.duration);
});

test("rejects text transposition outside the Mabinogi note range", () => {
  assert.throws(() => transposeMmlText("n0", -1), /지원 음역/);
  assert.throws(() => transposeMmlText("n107", 1), /지원 음역/);
});

test("transposes only notes in the selected MML range and restores the surrounding octave", () => {
  const source = "// keep\nt120v11o4l8abcde";
  const start = source.indexOf("b");
  const shifted = transposeMmlTextRange(source, 1, start, start + 1);
  const before = parseTrack(source);
  const after = parseTrack(shifted);
  assert.deepEqual(after.notes.map((note) => note.midi), [69, 72, 60, 62, 64]);
  assert.deepEqual(after.notes.map(({ tick, duration, velocity }) => ({ tick, duration, velocity })), before.notes.map(({ tick, duration, velocity }) => ({ tick, duration, velocity })));
  assert.match(shifted, /\/\/ keep/);
  assert.match(shifted, /o5co4c/);
});

test("keeps the rewritten MML range selected after transposition", () => {
  const source = "o4b8c8";
  const first = transposeMmlTextRangeWithSelection(source, 1, source.indexOf("b8"), source.indexOf("b8") + 2);
  assert.equal(first.source.slice(first.selectionStart, first.selectionEnd), "o5c8o4");
  assert.deepEqual(parseTrack(first.source).notes.map((note) => note.midi), [72, 60]);

  const second = transposeMmlTextRangeWithSelection(first.source, 1, first.selectionStart, first.selectionEnd);
  assert.ok(second.selectionEnd > second.selectionStart);
  assert.deepEqual(parseTrack(second.source).notes.map((note) => note.midi), [73, 60]);
});

test("transposes selected absolute notes and complete tied notes without touching neighbors", () => {
  const source = "o4c8n46d8&d8e8";
  const absoluteStart = source.indexOf("n46");
  const absoluteShifted = transposeMmlTextRange(source, -1, absoluteStart, absoluteStart + 3);
  assert.match(absoluteShifted, /n45/);
  assert.deepEqual(parseTrack(absoluteShifted).notes.map((note) => note.midi), [60, 57, 62, 64]);

  const tiedStart = source.indexOf("d8");
  const tiedShifted = transposeMmlTextRange(source, 1, tiedStart, tiedStart + 1);
  assert.deepEqual(parseTrack(tiedShifted).notes.map((note) => note.midi), [60, 58, 63, 64]);
  assert.equal(parseTrack(tiedShifted).notes[2].duration, parseTrack(source).notes[2].duration);
});

test("rejects selected-range transposition when no note is selected or the result is out of range", () => {
  assert.throws(() => transposeMmlTextRange("o4c8r8", 1, 4, 6), /이조할 음표/);
  assert.throws(() => transposeMmlTextRange("n107", 1, 0, 4), /지원 음역/);
});

test("chooses absolute notes when they are shorter than repeated octave jumps", () => {
  const source = "l8o1co8co1co8co1co8c";
  const optimized = optimizeMmlText(source);
  assert.match(optimized.source, /n[0-9]/);
  assert.match(optimized.source, /n96/);
  assert.equal(optimized.source.includes("n108"), false);
  assert.ok(optimized.source.length < source.length);
  assert.deepEqual(
    parseTrack(optimized.source).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })),
    parseTrack(source).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })),
  );
});

test("never makes an already compact real-world MML track longer", () => {
  const document = parseMmlDocument(readFileSync(new URL("./fixtures/complex-three-track.mml", import.meta.url), "utf8"));
  for (const track of document.tracks) {
    const optimized = optimizeMmlText(track.source);
    assert.ok(optimized.afterLength <= optimized.beforeLength);
    assert.deepEqual(
      parseTrack(optimized.source).notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
      track.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    );
  }
});

test("imports MabiIcco MMI score metadata and expands populated parts into nyangnyang tracks", () => {
  const source = `[mml-score]
version=1
title=고양이 합주
author=냥
time=3/4
tempo=0T113,384T126
mml-track=MML@t113o4c4,o3e4,,;
name=Lead
program=12
songProgram=-1
panpot=48
volume=80
visible=true
mml-track=MML@o2g2,,,o5c2;
name=Voice
program=0
songProgram=110
panpot=64
visible=false
[time-signature]
576=6/8`;
  const parsed = parseMmiDocument(source);
  assert.equal(parsed.title, "고양이 합주");
  assert.equal(parsed.author, "냥");
  assert.equal(parsed.tempo, 113);
  assert.deepEqual(parsed.timeSignature, { numerator: 3, denominator: 4 });
  assert.deepEqual(parsed.timeSignatureMap, [
    { tick: 0, numerator: 3, denominator: 4 },
    { tick: 576, numerator: 6, denominator: 8 },
  ]);
  assert.deepEqual(parsed.tracks.map((track) => track.name), ["Lead", "Lead · 화음 1", "Voice", "Voice · 노래"]);
  assert.equal(parsed.tracks[3].visible, false);
  assert.equal(parsed.tracks[0].mmi.program, 12);

  const project = createProjectFromMmi(source, "nyang-voice", "fallback");
  assert.equal(project.title, "고양이 합주");
  assert.equal(project.tracks.length, 4);
  assert.equal(project.tracks[0].mixerVolume, 0.8);
  assert.equal(project.tracks[3].pianoRollVisible, false);
  assert.deepEqual(project.routing.left, [project.tracks[0].id]);
  assert.deepEqual(project.routing.right, [project.tracks[1].id]);
  assert.deepEqual(parseTrack(project.tracks[0].sourceText).tempos.map(({ tick, bpm }) => ({ tick, bpm })), [{ tick: 0, bpm: 113 }, { tick: 384, bpm: 126 }]);
});

test("applies MMI track offsets as leading rests", () => {
  const parsed = parseMmiDocument(`[mml-score]
version=1
time=4/4
tempo=0T120
startOffset=192
startDelta=-96
startSongDelta=0
mml-track=MML@c4,,,g4;
name=Offset`);
  assert.equal(parsed.tracks[0].sourceText, "r4c4");
  assert.equal(parsed.tracks[1].sourceText, "r2g4");
});

test("serializes events with rests and exact note lengths", () => {
  const text = serializeTrackEvents([
    { tick: 48, duration: 48, midi: 60 },
    { tick: 96, duration: 96, midi: 64 },
  ]);
  const parsed = parseTrack(text);
  assert.deepEqual(parsed.notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })), [
    { tick: 48, duration: 48, midi: 60 },
    { tick: 96, duration: 96, midi: 64 },
  ]);
});

test("preserves per-note velocity while serializing imported events", () => {
  const parsed = parseTrack(serializeTrackEvents([
    { tick: 0, duration: 96, midi: 60, velocity: 4 },
    { tick: 96, duration: 96, midi: 64, velocity: 13 },
  ]));
  assert.deepEqual(parsed.notes.map((note) => note.velocity), [4, 13]);
});

test("imports MIDI notes, tempo, meter, and separates overlapping voices", () => {
  const midi = new MIDIBuilder({ timeDivision: 480, initialTempo: 90, format: 1, name: "고양이 MIDI" });
  midi.addEvent(0, 0, MIDIMessageTypes.timeSignature, [3, 2, 24, 8]);
  midi.addTrack("Piano");
  midi.noteOn(0, 1, 0, 60, 40);
  midi.noteOn(240, 1, 0, 64, 100);
  midi.noteOff(480, 1, 0, 60);
  midi.noteOff(720, 1, 0, 64);
  midi.setTempo(480, 120);
  midi.flush(true);

  const project = createProjectFromMidi(midi.writeMIDI(), "nyang-voice", "fallback");
  assert.equal(project.title, "고양이 MIDI");
  assert.equal(project.tracks.flatMap((track) => parseTrack(track.sourceText).tempos).find((event) => event.tick === 0).bpm, 90);
  assert.deepEqual(project.timeSignature, { numerator: 3, denominator: 4 });
  assert.notEqual(project.tracks[0].name, "Tempo");
  assert.equal(project.tracks.length, 2);
  assert.deepEqual(project.routing.left, [project.tracks[0].id]);
  assert.deepEqual(project.routing.right, [project.tracks[1].id]);
  const notes = project.tracks.flatMap((track) => parseTrack(track.sourceText).notes);
  assert.deepEqual(notes.map(({ tick, duration, midi: note }) => ({ tick, duration, midi: note })), [
    { tick: 0, duration: 96, midi: 60 },
    { tick: 48, duration: 96, midi: 64 },
  ]);
  assert.match(project.tracks[0].sourceText, /t90.*t120/);
});

test("exports a standard MIDI file that can be imported again", () => {
  const project = createProject();
  project.title = "냥 MIDI";
  project.timeSignature = { numerator: 6, denominator: 8 };
  project.timeSignatureMap = [{ tick: 0, numerator: 6, denominator: 8 }];
  project.tracks[0].sourceText = "t108o4v5c4v15e8g8";
  project.tracks[1].sourceText = "o3v9c2";
  project.tracks[2].sourceText = "";

  const binary = createMidiFile(project);
  assert.equal(new TextDecoder().decode(binary.slice(0, 4)), "MThd");
  assert.equal(midiFilename(project), "냥 MIDI.mid");
  const imported = createProjectFromMidi(binary, "nyang-voice", "fallback");
  assert.equal(imported.tracks.flatMap((track) => parseTrack(track.sourceText).tempos).find((event) => event.tick === 0).bpm, 108);
  assert.deepEqual(imported.timeSignature, { numerator: 6, denominator: 8 });
  assert.deepEqual(imported.tracks.flatMap((track) => parseTrack(track.sourceText).notes).map((note) => note.midi), [60, 64, 67, 48]);
});

test("converts ticks through tempo changes", () => {
  assert.equal(tickToSeconds(192, [{ tick: 96, bpm: 60 }]), 1.5);
  assert.equal(tempoAtTick(95, [{ tick: 0, bpm: 90 }, { tick: 96, bpm: 140 }]), 90);
  assert.equal(tempoAtTick(96, [{ tick: 0, bpm: 90 }, { tick: 96, bpm: 140 }]), 140);
});

test("quantizes raw audio times to the selected rhythm grid", () => {
  const result = quantizeInputs([{ id: "a", side: "left", midi: 60, startedAt: 10, endedAt: 10.49 }], 120, "1/8");
  assert.equal(result[0].tick, 0);
  assert.equal(result[0].duration, 96);
});

test("quantizes note length independently from a slightly late onset", () => {
  const result = quantizeInputs([{ id: "late", side: "left", midi: 60, startedAt: 10.14, endedAt: 10.54 }], 120, "1/8", 10);
  assert.equal(result[0].tick, 48);
  assert.equal(result[0].duration, 96);
  const ninetyBpm = quantizeInputs([{ id: "quarter", side: "left", midi: 60, startedAt: 3, endedAt: 3 + 2 / 3 }], 90, "1/8", 3);
  assert.equal(ninetyBpm[0].duration, 96);
});

test("chooses the closest fixed note value without inflating a near eighth note", () => {
  const [nearEighth] = quantizeInputs([
    { id: "near-eighth", side: "left", midi: 60, startedAt: 0, endedAt: 0.27 },
  ], 120, "1/8", 0);
  const [nearQuarter] = quantizeInputs([
    { id: "near-quarter", side: "left", midi: 62, startedAt: 0, endedAt: 0.46 },
  ], 120, "1/8", 0);
  const [exactMiddle] = quantizeInputs([
    { id: "middle", side: "left", midi: 64, startedAt: 0, endedAt: 0.375 },
  ], 120, "1/8", 0);

  assert.equal(nearEighth.duration, 48);
  assert.equal(nearQuarter.duration, 96);
  assert.equal(exactMiddle.duration, 48);
});

test("settles the append cursor at each quantized note end", () => {
  const shortC = { id: "c", side: "left", midi: 60, startedAt: 0, endedAt: 0.1 };
  assert.equal(quantizedInputsEndTick([shortC], 120, "1/8", 0), 48);

  const shortE = { id: "e", side: "left", midi: 64, startedAt: 0.25, endedAt: 0.35 };
  assert.equal(quantizedInputsEndTick([shortC, shortE], 120, "1/8", 0), 96);

  const overheldC = { id: "long-c", side: "left", midi: 60, startedAt: 0, endedAt: 0.34 };
  assert.equal(quantizedInputsEndTick([overheldC], 120, "1/8", 0), 48);
});

test("snaps a recording start and the visible grid to the selected division", () => {
  assert.equal(quantizationGridTicks("1/4"), 96);
  assert.equal(snapTickToGrid(104, "1/4"), 96);
  assert.equal(snapTickToGrid(151, "1/4"), 192);
  assert.equal(snapTickToGrid(104, "off"), 104);
});

test("keeps a near-half-note release on the half-note grid boundary", () => {
  const [note] = quantizeInputs([
    { id: "near-half", side: "left", midi: 60, startedAt: 0.2, endedAt: 1.15 },
  ], 120, "1/4", 0);
  assert.equal(note.tick, 0);
  assert.equal(note.duration, 192);

  const [quarter] = quantizeInputs([
    { id: "quarter", side: "left", midi: 62, startedAt: 0.2, endedAt: 0.65 },
  ], 120, "1/4", 0);
  assert.equal(quarter.duration, 96);
});

test("serializes the recording tempo into the generated master track", () => {
  assert.match(serializeTrackEvents([{ tick: 0, duration: 96, midi: 60 }], { tempo: 90 }), /^t90v15/);
});

test("captures recording velocity per assigned track at note-on time", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }, { id: "t2", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    {
      id: "first",
      side: "left",
      midi: 60,
      startedAt: 0,
      endedAt: 0.5,
      velocityByTrack: { t1: 7, t2: 12 },
    },
    {
      id: "second",
      side: "left",
      midi: 62,
      startedAt: 0.5,
      endedAt: 1,
      velocityByTrack: { t1: 11, t2: 12 },
    },
  ], tracks, { left: ["t1"], right: [] }, { bpm: 120, quantize: "1/8", origin: 0 });

  assert.deepEqual(parseTrack(result.texts.get("t1")).notes.map((note) => note.velocity), [7, 11]);
  assert.match(result.texts.get("t1"), /^v15v7/);
  assert.match(result.texts.get("t1"), /v11/);
});

test("restores the previous track velocity after a recorded section", () => {
  const existing = parseTrack("v15c4r4e4").notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity }));
  const recorded = { tick: 96, duration: 96, midi: 62, velocity: 7 };
  const source = serializeTrackEvents([...existing, recorded], { velocity: existing[0].velocity });
  assert.deepEqual(parseTrack(source).notes.map(({ midi, velocity }) => ({ midi, velocity })), [
    { midi: 60, velocity: 15 },
    { midi: 62, velocity: 7 },
    { midi: 64, velocity: 15 },
  ]);
  assert.match(source, /v7/);
  assert.match(source, /v15[^v]*e4$/);
});

test("keeps a minimum grid duration for a very short recorded tap", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    { id: "tap", side: "left", midi: 60, startedAt: 3, endedAt: 3 },
  ], tracks, { left: ["t1"], right: [] }, { bpm: 120, quantize: "1/8", origin: 3 });
  assert.equal(result.endTick, 48);
  assert.equal(parseTrack(result.texts.get("t1")).notes[0].duration, 48);
});

test("auto rhythm recognition keeps straight and triplet values in one take", () => {
  const ticksPerSecond = 192;
  const result = quantizeInputs([
    { id: "straight", side: "left", midi: 60, startedAt: 0, endedAt: 48 / ticksPerSecond },
    { id: "triplet", side: "left", midi: 62, startedAt: 48 / ticksPerSecond, endedAt: 80 / ticksPerSecond },
  ], 120, "auto", 0);
  assert.equal(result[0].duration, 48);
  assert.equal(result[1].tick, 48);
  assert.equal(result[1].duration, 32);
});

test("maximizes preserved chord notes before pitch priority", () => {
  const inputs = [
    { id: "c", side: "left", midi: 60, tick: 0, duration: 96 },
    { id: "e", side: "right", midi: 64, tick: 0, duration: 96 },
  ];
  const allocation = allocateInputs(inputs, { left: ["t1"], right: ["t1", "t2"] }, "high");
  assert.equal(allocation.dropped.length, 0);
  assert.equal(allocation.assigned.find((item) => item.input.id === "c").trackId, "t1");
  assert.equal(allocation.assigned.find((item) => item.input.id === "e").trackId, "t2");
});

test("allocates delayed harmony to stable high and low tracks", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }, { id: "t2", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    { id: "c", side: "left", midi: 60, startedAt: 0, endedAt: 1 },
    { id: "e", side: "left", midi: 64, startedAt: 0.5, endedAt: 1 },
  ], tracks, { left: ["t1", "t2"], right: [] }, { bpm: 120, quantize: "1/8", pitchPriority: "high" });
  const high = parseTrack(result.texts.get("t1"));
  const low = parseTrack(result.texts.get("t2"));
  assert.equal(high.notes[0].midi, 64);
  assert.equal(high.notes[0].tick, 96);
  assert.equal(low.notes[0].midi, 60);
  assert.equal(low.notes[0].duration, 192);
});

test("keeps short legato notes on one track without shortening the first note", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    { id: "c", side: "left", midi: 60, startedAt: 0, endedAt: 0.63 },
    { id: "d", side: "left", midi: 62, startedAt: 0.6, endedAt: 1.1 },
  ], tracks, { left: ["t1"], right: [] }, { bpm: 120, quantize: "1/8", pitchPriority: "high", origin: 0 });
  const parsed = parseTrack(result.texts.get("t1"));
  assert.equal(result.dropped.length, 0);
  assert.deepEqual(parsed.notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })), [
    { tick: 0, duration: 144, midi: 60 },
    { tick: 144, duration: 96, midi: 62 },
  ]);
});

test("keeps a sub-grid overlap on the original route even when two tracks are available", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }, { id: "t2", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    { id: "half", side: "left", midi: 60, startedAt: 0, endedAt: 0.95 },
    { id: "overlap", side: "left", midi: 62, startedAt: 0.5, endedAt: 1.2 },
  ], tracks, { left: ["t1", "t2"], right: [] }, { bpm: 120, quantize: "1/4", pitchPriority: "low", origin: 0 });
  assert.deepEqual(parseTrack(result.texts.get("t1")).notes.map(({ tick, duration, midi }) => ({ tick, duration, midi })), [
    { tick: 0, duration: 192, midi: 60 },
    { tick: 192, duration: 96, midi: 62 },
  ]);
  assert.equal(parseTrack(result.texts.get("t2")).notes.length, 0);
  assert.equal(result.dropped.length, 0);
});

test("does not collapse a real delayed harmony or simultaneous chord", () => {
  const quantized = quantizeInputs([
    { id: "c", side: "left", midi: 60, startedAt: 0, endedAt: 1 },
    { id: "e", side: "left", midi: 64, startedAt: 0.5, endedAt: 1 },
    { id: "g", side: "right", midi: 67, startedAt: 0, endedAt: 0.5 },
    { id: "b", side: "right", midi: 71, startedAt: 0, endedAt: 0.5 },
  ], 120, "1/8", 0);
  const normalized = closeShortLegatoOverlaps(quantized, "1/8");
  assert.equal(normalized.find((note) => note.id === "c").duration, 192);
  assert.equal(normalized.find((note) => note.id === "g").duration, 96);
  assert.equal(normalized.find((note) => note.id === "b").duration, 96);
});

test("preserves a short delayed harmony when enough tracks are connected", () => {
  const tracks = [{ id: "t1", recordVelocity: 15 }, { id: "t2", recordVelocity: 15 }];
  const result = recordingToTrackTexts([
    { id: "c", side: "left", midi: 60, startedAt: 0, endedAt: 0.75 },
    { id: "e", side: "left", midi: 64, startedAt: 0.5, endedAt: 1 },
  ], tracks, { left: ["t1", "t2"], right: [] }, { bpm: 120, quantize: "1/8", pitchPriority: "high", origin: 0 });
  assert.equal(result.dropped.length, 0);
  assert.equal(result.assigned.find((item) => item.input.id === "c").input.duration, 144);
  assert.notEqual(
    result.assigned.find((item) => item.input.id === "c").trackId,
    result.assigned.find((item) => item.input.id === "e").trackId,
  );
});

test("builds measure labels and beat lines from the same tick positions", () => {
  const grid = buildTimelineGrid(1536, [{ tick: 0, numerator: 4, denominator: 4 }], { numerator: 4, denominator: 4 });
  assert.deepEqual(grid.measures.map((marker) => marker.tick), [0, 384, 768, 1152, 1536]);
  assert.deepEqual(grid.measures.map((marker) => marker.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(grid.beats.slice(0, 3).map((marker) => marker.tick), [96, 192, 288]);
});

test("keeps playback metronome beats on the song grid across a mid-measure tempo change", () => {
  const beats = buildMetronomeEvents(384, [{ tick: 0, numerator: 4, denominator: 4 }]);
  assert.deepEqual(beats.map((beat) => beat.tick), [0, 96, 192, 288, 384]);
  assert.deepEqual(beats.slice(0, 4).map((beat) => beat.beat), [0, 1, 2, 3]);
  const tempos = [{ tick: 0, bpm: 120 }, { tick: 144, bpm: 60 }];
  assert.deepEqual(beats.slice(0, 4).map((beat) => tickToSeconds(beat.tick, tempos)), [0, 0.5, 1.25, 2.25]);
});

test("starts a new measure exactly at a time-signature change", () => {
  const grid = buildTimelineGrid(960, [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 384, numerator: 6, denominator: 8 },
  ], { numerator: 4, denominator: 4 });
  assert.deepEqual(grid.measures.map((marker) => marker.tick), [0, 384, 672, 960]);
  assert.deepEqual(grid.measures.map((marker) => marker.number), [1, 2, 3, 4]);
});

test("moves the playhead by measure boundaries and to the song edges", () => {
  const measures = [{ tick: 0 }, { tick: 384 }, { tick: 672 }, { tick: 960 }];
  assert.equal(adjacentMeasureTick(measures, 500, -1, 1100), 384);
  assert.equal(adjacentMeasureTick(measures, 384, -1, 1100), 0);
  assert.equal(adjacentMeasureTick(measures, 500, 1, 1100), 672);
  assert.equal(adjacentMeasureTick(measures, 960, 1, 1100), 1100);
});

test("follows a recording playhead after it reaches the visible timeline anchor", () => {
  assert.equal(followTimelineScroll(0, 1000, 3000, 600), 0);
  assert.equal(followTimelineScroll(0, 1000, 3000, 700), 50);
  assert.equal(followTimelineScroll(50, 1000, 3000, 800), 150);
  assert.equal(followTimelineScroll(1800, 1000, 2500, 2500), 1500);
  assert.equal(followTimelineScroll(1000, 1000, 3000, 900), 700);
  assert.equal(followTimelineScroll(1000, 1000, 3000, 1150), 950);
});

test("keeps the append playhead on the live note's right edge", () => {
  assert.equal(liveNotesEndTick([{ tick: 384, duration: 71.6 }], 999), 456);
  assert.equal(liveNotesEndTick([
    { tick: 384, duration: 48 },
    { tick: 408, duration: 72 },
  ], 999), 480);
  assert.equal(liveNotesEndTick([], 432.4), 432);
});

test("settles a short legato release while the next append note remains held", () => {
  const completed = [{ id: "c", inputId: "c", side: "left", midi: 60, startedAt: 0, endedAt: 0.51 }];
  const next = [{ id: "e", inputId: "e", side: "left", midi: 64, startedAt: 0.49 }];
  assert.deepEqual(appendLegatoContinuation(completed, next, 120, "1/8"), {
    inputId: "e",
    settledTick: 96,
  });
  assert.equal(appendLegatoContinuation(completed, [{ ...next[0], startedAt: 0.2 }], 120, "1/8"), null);
  assert.equal(appendLegatoContinuation(completed, [{ ...next[0], startedAt: 0.01 }], 120, "1/8"), null);
  assert.equal(appendLegatoContinuation(completed, [], 120, "1/8"), null);
});
