import { BasicMIDI, MIDIBuilder, MIDIMessageTypes } from "spessasynth_core";
import { mergeTempoCommands, parseTrack, serializeTrackEvents, TICKS_PER_QUARTER } from "./core.js";
import { createProject, createTrack } from "./project.js";

const textDecoder = new TextDecoder("utf-8");

function scaledTick(tick, division) {
  return Math.max(0, Math.round((tick * TICKS_PER_QUARTER) / division));
}

function closeNote(active, notes, key, endTick) {
  const queue = active.get(key);
  if (!queue?.length) return;
  const note = queue.shift();
  if (!queue.length) active.delete(key);
  notes.push({
    tick: note.tick,
    duration: Math.max(1, endTick - note.tick),
    midi: note.midi,
    velocity: note.velocity,
  });
}

function notesByChannel(track, division, fallbackEnd) {
  const active = new Map();
  const result = new Map();
  const events = [...track.events].sort((a, b) => a.ticks - b.ticks);
  for (const event of events) {
    const status = event.statusByte & 0xf0;
    if (status !== MIDIMessageTypes.noteOn && status !== MIDIMessageTypes.noteOff) continue;
    const channel = event.statusByte & 0x0f;
    const midi = event.data[0];
    const key = `${channel}:${midi}`;
    const tick = scaledTick(event.ticks, division);
    if (status === MIDIMessageTypes.noteOn && event.data[1] > 0) {
      const queue = active.get(key) ?? [];
      queue.push({
        tick,
        midi,
        velocity: Math.max(0, Math.min(15, Math.round((event.data[1] / 127) * 15))),
        channel,
      });
      active.set(key, queue);
    } else {
      const notes = result.get(channel) ?? [];
      closeNote(active, notes, key, tick);
      result.set(channel, notes);
    }
  }
  const endTick = scaledTick(fallbackEnd, division);
  for (const [key, queue] of active) {
    const channel = Number(key.split(":")[0]);
    const notes = result.get(channel) ?? [];
    while (queue.length) closeNote(active, notes, key, Math.max(endTick, queue[0].tick + 1));
    result.set(channel, notes);
  }
  return result;
}

function splitVoices(notes) {
  const voices = [];
  for (const note of [...notes].sort((a, b) => a.tick - b.tick || a.midi - b.midi)) {
    let voice = voices.find((candidate) => candidate.end <= note.tick);
    if (!voice) {
      voice = { end: 0, notes: [] };
      voices.push(voice);
    }
    voice.notes.push(note);
    voice.end = note.tick + note.duration;
  }
  return voices.map((voice) => voice.notes);
}

function uniqueTempos(midi) {
  const byTick = new Map();
  for (const event of midi.tempoChanges ?? []) {
    const tick = scaledTick(event.ticks, midi.timeDivision);
    if (!byTick.has(tick)) byTick.set(tick, Math.max(1, Math.round(event.tempo)));
  }
  if (!byTick.has(0)) byTick.set(0, 120);
  return [...byTick].map(([tick, bpm]) => ({ tick, bpm })).sort((a, b) => a.tick - b.tick);
}

function timeSignatures(midi) {
  const markers = [];
  for (const track of midi.tracks) {
    for (const event of track.events) {
      if (event.statusByte !== MIDIMessageTypes.timeSignature || event.data.length < 2) continue;
      markers.push({
        tick: scaledTick(event.ticks, midi.timeDivision),
        numerator: Math.max(1, event.data[0]),
        denominator: 2 ** event.data[1],
      });
    }
  }
  const byTick = new Map(markers.sort((a, b) => a.tick - b.tick).map((marker) => [marker.tick, marker]));
  if (!byTick.has(0)) byTick.set(0, { tick: 0, numerator: 4, denominator: 4 });
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function decodedTrackName(track, fallback) {
  const event = track.events.find((item) => item.statusByte === MIDIMessageTypes.trackName);
  if (!event) return track.name?.trim() || fallback;
  try {
    return textDecoder.decode(event.data).replace(/\0+$/g, "").trim() || fallback;
  } catch {
    return track.name?.trim() || fallback;
  }
}

export function createProjectFromMidi(arrayBuffer, themeId = "nyang-voice", fallbackTitle = "") {
  const midi = BasicMIDI.fromArrayBuffer(arrayBuffer, fallbackTitle);
  if (!Number.isFinite(midi.timeDivision) || midi.timeDivision <= 0) {
    throw new Error("SMPTE 시간 형식의 MIDI 파일은 아직 불러올 수 없습니다.");
  }
  const tempos = uniqueTempos(midi);
  const meterMap = timeSignatures(midi);
  const importedTracks = [];
  for (let trackIndex = 0; trackIndex < midi.tracks.length; trackIndex += 1) {
    const midiTrack = midi.tracks[trackIndex];
    const channels = notesByChannel(midiTrack, midi.timeDivision, midi.lastVoiceEventTick);
    const channelCount = [...channels.values()].filter((notes) => notes.length).length;
    for (const [channel, notes] of channels) {
      const voices = splitVoices(notes);
      voices.forEach((voiceNotes, voiceIndex) => {
        const track = createTrack(importedTracks.length, themeId);
        const baseName = decodedTrackName(midiTrack, `MIDI Track ${trackIndex + 1}`);
        const suffixes = [];
        if (channelCount > 1) suffixes.push(`Ch ${channel + 1}`);
        if (voices.length > 1) suffixes.push(`Voice ${voiceIndex + 1}`);
        track.name = suffixes.length ? `${baseName} · ${suffixes.join(" · ")}` : baseName;
        track.sourceText = serializeTrackEvents(voiceNotes, {
          velocity: voiceNotes[0]?.velocity ?? 15,
          tempo: tempos.length === 1 ? tempos[0].bpm : null,
        });
        track.recordVelocity = voiceNotes[0]?.velocity ?? 15;
        importedTracks.push(track);
      });
    }
  }
  if (!importedTracks.length) throw new Error("연주 음표가 들어 있는 MIDI 트랙을 찾지 못했습니다.");

  const tracks = importedTracks;
  if (tempos.length > 1) tracks[0].sourceText = mergeTempoCommands(tracks[0].sourceText, tempos);
  const project = createProject(themeId);
  const firstMusicIndex = 0;
  project.title = midi.getName?.("utf-8") || fallbackTitle;
  project.tracks = tracks;
  project.timeSignature = { numerator: meterMap[0].numerator, denominator: meterMap[0].denominator };
  project.timeSignatureMap = meterMap;
  project.routing = {
    left: tracks[firstMusicIndex] ? [tracks[firstMusicIndex].id] : [],
    right: tracks[firstMusicIndex + 1] ? [tracks[firstMusicIndex + 1].id] : [],
  };
  project.view.selectedTrackId = tracks[firstMusicIndex].id;
  return project;
}

function midiVelocity(velocity) {
  return Math.max(1, Math.min(127, Math.round((Math.max(0, Math.min(15, velocity)) / 15) * 127)));
}

function safeTitle(project) {
  return project.title?.trim() || "nyangnyang";
}

export function createMidiFile(project) {
  const tempoByTick = new Map();
  for (const track of project.tracks) {
    for (const event of parseTrack(track.sourceText).tempos) {
      if (!tempoByTick.has(event.tick)) tempoByTick.set(event.tick, event.bpm);
    }
  }
  if (!tempoByTick.has(0)) tempoByTick.set(0, 120);
  const initialTempo = tempoByTick.get(0);
  const builder = new MIDIBuilder({
    timeDivision: TICKS_PER_QUARTER,
    initialTempo: Math.max(1, Math.round(initialTempo)),
    format: 1,
    name: safeTitle(project),
  });
  for (const [tick, bpm] of [...tempoByTick].sort((a, b) => a[0] - b[0])) {
    if (tick === 0 && Math.round(bpm) === Math.round(initialTempo)) continue;
    builder.setTempo(Math.max(0, Math.round(tick)), Math.max(1, bpm));
  }
  for (const marker of project.timeSignatureMap ?? []) {
    const denominatorPower = Math.max(0, Math.round(Math.log2(Math.max(1, marker.denominator))));
    builder.addEvent(Math.max(0, Math.round(marker.tick)), 0, MIDIMessageTypes.timeSignature, [
      Math.max(1, Math.round(marker.numerator)),
      denominatorPower,
      24,
      8,
    ]);
  }
  let channelIndex = 0;
  for (const track of project.tracks) {
    const parsed = parseTrack(track.sourceText);
    if (!parsed.notes.length) continue;
    builder.addTrack(track.name || `Track ${builder.tracks.length}`);
    const outputTrack = builder.tracks.length - 1;
    let channel = channelIndex % 15;
    if (channel >= 9) channel += 1;
    channelIndex += 1;
    builder.programChange(0, outputTrack, channel, 0);
    const events = [];
    for (const note of parsed.notes) {
      events.push({ tick: Math.max(0, Math.round(note.tick)), order: 1, note });
      events.push({ tick: Math.max(0, Math.round(note.tick + note.duration)), order: 0, note });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.note.midi - b.note.midi);
    for (const event of events) {
      if (event.order === 0) builder.noteOff(event.tick, outputTrack, channel, event.note.midi);
      else builder.noteOn(event.tick, outputTrack, channel, event.note.midi, midiVelocity(event.note.velocity));
    }
  }
  builder.flush(true);
  return builder.writeMIDI();
}

export function midiFilename(project) {
  const title = safeTitle(project).replace(/[\\/:*?"<>|]+/g, "-");
  return `${title}.mid`;
}
