export const TICKS_PER_QUARTER = 96;
export const TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4;
// Mabinogi MML numbers C0 as n0, while Web Audio/MIDI numbers C0 as 12.
export const MML_NOTE_NUMBER_MIDI_OFFSET = 12;

export function mmlNoteNumberToMidi(noteNumber) {
  return noteNumber + MML_NOTE_NUMBER_MIDI_OFFSET;
}

export function midiToMmlNoteNumber(midi) {
  return midi - MML_NOTE_NUMBER_MIDI_OFFSET;
}

const NOTE_CLASS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

export class MmlSyntaxError extends Error {
  constructor(message, index, length = 1) {
    super(message);
    this.name = "MmlSyntaxError";
    this.index = index;
    this.length = length;
  }
}

export function stripComments(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      const start = index;
      result += "  ";
      index += 2;
      while (index < source.length && !source.startsWith("*/", index)) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index >= source.length) throw new MmlSyntaxError("닫히지 않은 여러 줄 주석입니다.", start, 2);
      result += "  ";
      index += 2;
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

function readNumber(source, start) {
  let end = start;
  while (end < source.length && /[0-9]/.test(source[end])) end += 1;
  if (end === start) return { value: null, end };
  return { value: Number(source.slice(start, end)), end };
}

function durationTicks(denominator, dots, index) {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new MmlSyntaxError("음 길이는 1 이상의 숫자여야 합니다.", index);
  }
  let ticks = TICKS_PER_WHOLE / denominator;
  let addition = ticks / 2;
  for (let dot = 0; dot < dots; dot += 1) {
    ticks += addition;
    addition /= 2;
  }
  return ticks;
}

export function parseTrack(source, options = {}) {
  const clean = stripComments(source);
  const state = {
    tick: 0,
    octave: options.octave ?? 4,
    defaultLength: options.defaultLength ?? 4,
    defaultDots: options.defaultDots ?? 0,
    tempo: options.tempo ?? 120,
    velocity: options.velocity ?? 15,
  };
  const notes = [];
  const rests = [];
  const tempos = [];
  let pendingTie = false;
  let index = 0;

  while (index < clean.length) {
    const character = clean[index].toLowerCase();
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === ";") {
      index += 1;
      continue;
    }
    if (character === "&") {
      if (notes.length === 0 || pendingTie) throw new MmlSyntaxError("연결할 앞 음이 없습니다.", index);
      pendingTie = true;
      index += 1;
      continue;
    }
    if (character === "<" || character === ">") {
      state.octave += character === ">" ? 1 : -1;
      index += 1;
      continue;
    }
    if (["l", "o", "t", "v"].includes(character)) {
      const commandStart = index;
      const number = readNumber(clean, index + 1);
      if (number.value === null) throw new MmlSyntaxError(`${character} 뒤에 숫자가 필요합니다.`, commandStart);
      if (character === "l") {
        if (number.value <= 0) throw new MmlSyntaxError("기본 음 길이는 1 이상이어야 합니다.", commandStart, number.end - commandStart);
        state.defaultLength = number.value;
        let dots = 0;
        while (clean[number.end + dots] === ".") dots += 1;
        state.defaultDots = dots;
        index = number.end + dots;
      } else if (character === "o") {
        state.octave = number.value;
      } else if (character === "v") {
        state.velocity = Math.max(0, Math.min(15, number.value));
      } else {
        if (number.value <= 0) throw new MmlSyntaxError("템포는 1 이상이어야 합니다.", commandStart, number.end - commandStart);
        state.tempo = number.value;
        tempos.push({ tick: state.tick, bpm: state.tempo, sourceStart: commandStart, sourceEnd: number.end });
      }
      if (character !== "l") index = number.end;
      continue;
    }

    const isAbsolute = character === "n";
    const isRest = character === "r";
    const isNote = Object.hasOwn(NOTE_CLASS, character);
    if (!isAbsolute && !isRest && !isNote) {
      throw new MmlSyntaxError(`해석할 수 없는 문자 '${source[index]}'입니다.`, index);
    }

    const tokenStart = index;
    index += 1;
    let midi = null;
    if (isAbsolute) {
      const number = readNumber(clean, index);
      if (number.value === null) throw new MmlSyntaxError("n 뒤에 음 번호가 필요합니다.", tokenStart);
      midi = mmlNoteNumberToMidi(number.value);
      index = number.end;
    } else if (isNote) {
      let accidental = 0;
      if (["+", "#", "-"].includes(clean[index])) {
        accidental = clean[index] === "-" ? -1 : 1;
        index += 1;
      }
      midi = 12 * (state.octave + 1) + NOTE_CLASS[character] + accidental;
    }

    const number = readNumber(clean, index);
    const denominator = number.value ?? state.defaultLength;
    index = number.end;
    let dots = 0;
    while (clean[index] === ".") {
      dots += 1;
      index += 1;
    }
    if (number.value === null && dots === 0) dots = state.defaultDots;
    const duration = durationTicks(denominator, dots, tokenStart);
    const sourceEnd = index;

    if (isRest) {
      if (pendingTie) throw new MmlSyntaxError("쉼표에는 앞 음을 연결할 수 없습니다.", tokenStart, sourceEnd - tokenStart);
      rests.push({ tick: state.tick, duration, sourceStart: tokenStart, sourceEnd });
    } else {
      const previous = notes.at(-1);
      if (pendingTie) {
        if (!previous || previous.midi !== midi || Math.abs(previous.tick + previous.duration - state.tick) > 0.0001) {
          throw new MmlSyntaxError("같은 높이의 이어지는 음만 &로 연결할 수 있습니다.", tokenStart, sourceEnd - tokenStart);
        }
        previous.duration += duration;
        previous.sourceEnd = sourceEnd;
      } else {
        notes.push({
          tick: state.tick,
          duration,
          midi,
          velocity: state.velocity,
          sourceStart: tokenStart,
          sourceEnd,
        });
      }
      pendingTie = false;
    }
    state.tick += duration;
  }

  if (pendingTie) throw new MmlSyntaxError("& 뒤에 연결할 음이 필요합니다.", Math.max(0, clean.length - 1));
  return { notes, rests, tempos, duration: state.tick, source };
}

export function transposeMmlText(source, semitones) {
  const original = String(source ?? "");
  const delta = Math.trunc(Number(semitones) || 0);
  const before = parseTrack(original);
  if (delta === 0) return original;

  let sourceOctave = 4;
  let outputOctave = 4;
  let index = 0;
  let result = "";
  const appendTargetNote = (midi, suffix) => {
    const targetMidi = midi + delta;
    const noteNumber = midiToMmlNoteNumber(targetMidi);
    if (noteNumber < 0 || noteNumber > 107) {
      throw new Error(`이조 결과가 지원 음역(C0~B8)을 벗어납니다: ${noteNumber < 0 ? "C0 아래" : "B8 위"}`);
    }
    const octave = Math.floor(targetMidi / 12) - 1;
    const pitchClass = ((targetMidi % 12) + 12) % 12;
    if (octave !== outputOctave) {
      result += `o${octave}`;
      outputOctave = octave;
    }
    result += `${NOTE_NAMES[pitchClass]}${suffix}`;
  };

  while (index < original.length) {
    if (original.startsWith("//", index)) {
      const end = original.indexOf("\n", index);
      const boundary = end < 0 ? original.length : end;
      result += original.slice(index, boundary);
      index = boundary;
      continue;
    }
    if (original.startsWith("/*", index)) {
      const end = original.indexOf("*/", index + 2);
      if (end < 0) throw new MmlSyntaxError("닫히지 않은 여러 줄 주석입니다.", index, 2);
      result += original.slice(index, end + 2);
      index = end + 2;
      continue;
    }

    const character = original[index].toLowerCase();
    if (character === "<" || character === ">") {
      sourceOctave += character === ">" ? 1 : -1;
      index += 1;
      continue;
    }
    if (character === "o") {
      const number = readNumber(original, index + 1);
      if (number.value === null) throw new MmlSyntaxError("o 뒤에 숫자가 필요합니다.", index);
      sourceOctave = number.value;
      index = number.end;
      continue;
    }
    if (["l", "t", "v"].includes(character)) {
      const number = readNumber(original, index + 1);
      if (number.value === null) throw new MmlSyntaxError(`${character} 뒤에 숫자가 필요합니다.`, index);
      let end = number.end;
      if (character === "l") while (original[end] === ".") end += 1;
      result += original.slice(index, end);
      index = end;
      continue;
    }
    if (character === "n") {
      const number = readNumber(original, index + 1);
      if (number.value === null) throw new MmlSyntaxError("n 뒤에 음 번호가 필요합니다.", index);
      appendTargetNote(mmlNoteNumberToMidi(number.value), "");
      index = number.end;
      continue;
    }
    if (Object.hasOwn(NOTE_CLASS, character)) {
      let end = index + 1;
      let accidental = 0;
      if (["+", "#", "-"].includes(original[end])) {
        accidental = original[end] === "-" ? -1 : 1;
        end += 1;
      }
      const suffixStart = end;
      while (/[0-9]/.test(original[end] ?? "")) end += 1;
      while (original[end] === ".") end += 1;
      const midi = 12 * (sourceOctave + 1) + NOTE_CLASS[character] + accidental;
      appendTargetNote(midi, original.slice(suffixStart, end));
      index = end;
      continue;
    }

    result += original[index];
    index += 1;
  }

  const after = parseTrack(result);
  if (before.notes.length !== after.notes.length
    || before.notes.some((note, noteIndex) => {
      const shifted = after.notes[noteIndex];
      return shifted.midi !== note.midi + delta
        || shifted.tick !== note.tick
        || shifted.duration !== note.duration
        || shifted.velocity !== note.velocity;
    })
    || before.duration !== after.duration
    || JSON.stringify(before.tempos.map(({ tick, bpm }) => ({ tick, bpm }))) !== JSON.stringify(after.tempos.map(({ tick, bpm }) => ({ tick, bpm })))) {
    throw new Error("이조 후 MML 검증에 실패했습니다.");
  }
  return result;
}

export function transposeMmlTextRange(source, semitones, selectionStart, selectionEnd) {
  const original = String(source ?? "");
  const delta = Math.trunc(Number(semitones) || 0);
  const rangeStart = Math.max(0, Math.min(original.length, Math.trunc(Number(selectionStart) || 0)));
  const rangeEnd = Math.max(rangeStart, Math.min(original.length, Math.trunc(Number(selectionEnd) || 0)));
  if (delta === 0 || rangeStart === rangeEnd) return original;

  const before = parseTrack(original);
  const selectedNotes = before.notes.filter((note) => note.sourceStart < rangeEnd && note.sourceEnd > rangeStart);
  if (!selectedNotes.length) throw new Error("선택한 범위에 이조할 음표가 없습니다.");
  const selectedRanges = selectedNotes.map((note) => ({ start: note.sourceStart, end: note.sourceEnd }));
  const tokenIsSelected = (start) => selectedRanges.some((range) => start >= range.start && start < range.end);
  const shiftedMidiAt = (midi, tokenStart) => {
    if (!tokenIsSelected(tokenStart)) return midi;
    const targetMidi = midi + delta;
    const noteNumber = midiToMmlNoteNumber(targetMidi);
    if (noteNumber < 0 || noteNumber > 107) {
      throw new Error(`이조 결과가 지원 음역(C0~B8)을 벗어납니다: ${noteNumber < 0 ? "C0 아래" : "B8 위"}`);
    }
    return targetMidi;
  };

  let sourceOctave = 4;
  let index = 0;
  let result = "";
  while (index < original.length) {
    if (original.startsWith("//", index)) {
      const end = original.indexOf("\n", index);
      const boundary = end < 0 ? original.length : end;
      result += original.slice(index, boundary);
      index = boundary;
      continue;
    }
    if (original.startsWith("/*", index)) {
      const end = original.indexOf("*/", index + 2);
      if (end < 0) throw new MmlSyntaxError("닫히지 않은 여러 줄 주석입니다.", index, 2);
      result += original.slice(index, end + 2);
      index = end + 2;
      continue;
    }

    const tokenStart = index;
    const character = original[index].toLowerCase();
    if (character === "<" || character === ">") {
      sourceOctave += character === ">" ? 1 : -1;
      result += original[index];
      index += 1;
      continue;
    }
    if (character === "o") {
      const number = readNumber(original, index + 1);
      if (number.value === null) throw new MmlSyntaxError("o 뒤에 숫자가 필요합니다.", index);
      sourceOctave = number.value;
      result += original.slice(index, number.end);
      index = number.end;
      continue;
    }
    if (character === "n") {
      const number = readNumber(original, index + 1);
      if (number.value === null) throw new MmlSyntaxError("n 뒤에 음 번호가 필요합니다.", index);
      if (tokenIsSelected(tokenStart)) {
        const shiftedMidi = shiftedMidiAt(mmlNoteNumberToMidi(number.value), tokenStart);
        result += `n${midiToMmlNoteNumber(shiftedMidi)}`;
      } else {
        result += original.slice(index, number.end);
      }
      index = number.end;
      continue;
    }
    if (Object.hasOwn(NOTE_CLASS, character)) {
      let end = index + 1;
      let accidental = 0;
      if (["+", "#", "-"].includes(original[end])) {
        accidental = original[end] === "-" ? -1 : 1;
        end += 1;
      }
      const suffixStart = end;
      while (/[0-9]/.test(original[end] ?? "")) end += 1;
      while (original[end] === ".") end += 1;
      if (tokenIsSelected(tokenStart)) {
        const midi = 12 * (sourceOctave + 1) + NOTE_CLASS[character] + accidental;
        const shiftedMidi = shiftedMidiAt(midi, tokenStart);
        const shiftedOctave = Math.floor(shiftedMidi / 12) - 1;
        const pitchClass = ((shiftedMidi % 12) + 12) % 12;
        const shiftedNote = `${NOTE_NAMES[pitchClass]}${original.slice(suffixStart, end)}`;
        result += shiftedOctave === sourceOctave ? shiftedNote : `o${shiftedOctave}${shiftedNote}o${sourceOctave}`;
      } else {
        result += original.slice(index, end);
      }
      index = end;
      continue;
    }

    result += original[index];
    index += 1;
  }

  const after = parseTrack(result);
  if (before.notes.length !== after.notes.length
    || before.notes.some((note, noteIndex) => {
      const shifted = after.notes[noteIndex];
      const selected = note.sourceStart < rangeEnd && note.sourceEnd > rangeStart;
      return shifted.midi !== note.midi + (selected ? delta : 0)
        || shifted.tick !== note.tick
        || shifted.duration !== note.duration
        || shifted.velocity !== note.velocity;
    })
    || before.duration !== after.duration
    || JSON.stringify(before.tempos.map(({ tick, bpm }) => ({ tick, bpm }))) !== JSON.stringify(after.tempos.map(({ tick, bpm }) => ({ tick, bpm })))) {
    throw new Error("선택 영역 이조 후 MML 검증에 실패했습니다.");
  }
  return result;
}

export function transposeMmlTextRangeWithSelection(source, semitones, selectionStart, selectionEnd) {
  const original = String(source ?? "");
  const rangeStart = Math.max(0, Math.min(original.length, Math.trunc(Number(selectionStart) || 0)));
  const rangeEnd = Math.max(rangeStart, Math.min(original.length, Math.trunc(Number(selectionEnd) || 0)));
  const selectedNotes = parseTrack(original).notes.filter((note) => note.sourceStart < rangeEnd && note.sourceEnd > rangeStart);
  if (!selectedNotes.length) {
    transposeMmlTextRange(original, semitones, rangeStart, rangeEnd);
    throw new Error("선택한 범위에 이조할 음표가 없습니다.");
  }

  const tokenStart = Math.min(...selectedNotes.map((note) => note.sourceStart));
  const tokenEnd = Math.max(...selectedNotes.map((note) => note.sourceEnd));
  let markerIndex = 0;
  let startMarker = "";
  let endMarker = "";
  do {
    startMarker = `/*__nyang_selection_start_${markerIndex}__*/`;
    endMarker = `/*__nyang_selection_end_${markerIndex}__*/`;
    markerIndex += 1;
  } while (original.includes(startMarker) || original.includes(endMarker));

  const marked = `${original.slice(0, tokenStart)}${startMarker}${original.slice(tokenStart, tokenEnd)}${endMarker}${original.slice(tokenEnd)}`;
  const shiftedMarked = transposeMmlTextRange(
    marked,
    semitones,
    tokenStart + startMarker.length,
    tokenEnd + startMarker.length,
  );
  const markedStart = shiftedMarked.indexOf(startMarker);
  const contentStart = markedStart + startMarker.length;
  const markedEnd = shiftedMarked.indexOf(endMarker, contentStart);
  if (markedStart < 0 || markedEnd < 0) throw new Error("이조한 선택 범위를 복원하지 못했습니다.");

  return {
    source: `${shiftedMarked.slice(0, markedStart)}${shiftedMarked.slice(contentStart, markedEnd)}${shiftedMarked.slice(markedEnd + endMarker.length)}`,
    selectionStart: markedStart,
    selectionEnd: markedEnd - startMarker.length,
  };
}

function splitTracks(source) {
  const clean = stripComments(source);
  const trimmedStart = clean.search(/\S/);
  let bodyStart = trimmedStart < 0 ? 0 : trimmedStart;
  if (clean.slice(bodyStart, bodyStart + 4).toLowerCase() === "mml@") bodyStart += 4;
  let bodyEnd = clean.length;
  while (bodyEnd > bodyStart && /\s/.test(clean[bodyEnd - 1])) bodyEnd -= 1;
  if (clean[bodyEnd - 1] === ";") bodyEnd -= 1;
  const ranges = [];
  let start = bodyStart;
  for (let index = bodyStart; index <= bodyEnd; index += 1) {
    if (index === bodyEnd || clean[index] === ",") {
      ranges.push({ start, end: index, text: source.slice(start, index) });
      start = index + 1;
    }
  }
  return ranges.length ? ranges : [{ start: 0, end: 0, text: "" }];
}

export function parseMmlDocument(source) {
  const ranges = splitTracks(source);
  const tracks = ranges.map((range, trackIndex) => {
    try {
      const parsed = parseTrack(range.text);
      return {
        ...parsed,
        notes: parsed.notes.map((note) => ({
          ...note,
          trackIndex,
          sourceStart: note.sourceStart + range.start,
          sourceEnd: note.sourceEnd + range.start,
        })),
        sourceStart: range.start,
        sourceEnd: range.end,
      };
    } catch (error) {
      if (error instanceof MmlSyntaxError) {
        error.index += range.start;
        error.trackIndex = trackIndex;
      }
      throw error;
    }
  });
  return { tracks, duration: Math.max(0, ...tracks.map((track) => track.duration)) };
}

export function combineTracks(trackTexts, { removeComments = false } = {}) {
  const values = trackTexts.map((text) => removeComments ? stripComments(text).replace(/\s+/g, "") : text);
  return `MML@${values.join(",")};`;
}

function lengthCandidates() {
  const values = [];
  for (let denominator = 1; denominator <= 96; denominator += 1) {
    for (let dots = 0; dots <= 2; dots += 1) {
      const ticks = durationTicks(denominator, dots, 0);
      if (Number.isInteger(ticks)) values.push({ denominator, dots, ticks });
    }
  }
  return values.sort((a, b) => b.ticks - a.ticks || a.denominator - b.denominator || a.dots - b.dots);
}

const LENGTH_CANDIDATES = lengthCandidates();

export function encodeDuration(ticks) {
  let remaining = Math.max(1, Math.round(ticks));
  const parts = [];
  while (remaining > 0 && parts.length < 32) {
    const exact = LENGTH_CANDIDATES.find((candidate) => candidate.ticks === remaining);
    const candidate = exact ?? LENGTH_CANDIDATES.find((item) => item.ticks < remaining) ?? LENGTH_CANDIDATES.at(-1);
    parts.push(`${candidate.denominator}${".".repeat(candidate.dots)}`);
    remaining -= candidate.ticks;
  }
  return parts;
}

function encodeEvent(midi, duration, currentOctave) {
  const octave = Math.floor(midi / 12) - 1;
  const pitchClass = ((midi % 12) + 12) % 12;
  const prefix = octave === currentOctave ? "" : `o${octave}`;
  const lengths = encodeDuration(duration);
  return {
    octave,
    text: lengths.map((length, index) => `${index === 0 ? prefix : ""}${NOTE_NAMES[pitchClass]}${length}`).join("&"),
  };
}

export function serializeTrackEvents(events, { velocity = 15, initialOctave = 4, tempo = null } = {}) {
  const ordered = [...events].sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  let cursor = 0;
  let octave = initialOctave;
  let currentVelocity = Math.max(0, Math.min(15, Math.round(velocity)));
  let result = `${Number.isFinite(tempo) && tempo > 0 ? `t${Math.round(tempo)}` : ""}v${currentVelocity}`;
  for (const event of ordered) {
    const gap = Math.max(0, Math.round(event.tick - cursor));
    if (gap > 0) result += encodeDuration(gap).map((length) => `r${length}`).join("");
    const eventVelocity = Number.isFinite(event.velocity)
      ? Math.max(0, Math.min(15, Math.round(event.velocity)))
      : currentVelocity;
    if (eventVelocity !== currentVelocity) {
      result += `v${eventVelocity}`;
      currentVelocity = eventVelocity;
    }
    const encoded = encodeEvent(event.midi, event.duration, octave);
    result += encoded.text;
    octave = encoded.octave;
    cursor = Math.max(cursor, event.tick + event.duration);
  }
  return result;
}

function normalizedTempoEvents(events = []) {
  const byTick = new Map();
  for (const event of [...events].sort((a, b) => a.tick - b.tick)) {
    const tick = Math.max(0, Math.round(Number(event.tick) || 0));
    byTick.set(tick, Math.max(1, Math.round(Number(event.bpm) || 120)));
  }
  return [...byTick].map(([tick, bpm]) => ({ tick, bpm })).sort((a, b) => a.tick - b.tick);
}

export function serializeTrackWithTempos(source, tempoEvents) {
  const parsed = typeof source === "string" ? parseTrack(source) : source;
  const tempos = normalizedTempoEvents(tempoEvents);
  const tempoByTick = new Map(tempos.map((event) => [event.tick, event.bpm]));
  const tempoTicks = tempos.map((event) => event.tick);
  const emittedTempos = new Set();
  const items = [...parsed.notes.map((item) => ({ ...item, kind: "note" })), ...parsed.rests.map((item) => ({ ...item, kind: "rest" }))]
    .sort((a, b) => a.tick - b.tick || a.sourceStart - b.sourceStart);
  let result = "";
  let cursor = 0;
  let currentVelocity = null;
  let currentOctave = 4;

  const emitTempo = (tick) => {
    if (!tempoByTick.has(tick) || emittedTempos.has(tick)) return;
    result += `t${tempoByTick.get(tick)}`;
    emittedTempos.add(tick);
  };
  const boundaries = (start, end) => [
    ...tempoTicks.filter((tick) => tick > start && tick < end),
    end,
  ];
  const emitRest = (start, end) => {
    let position = start;
    emitTempo(position);
    for (const boundary of boundaries(start, end)) {
      const duration = boundary - position;
      if (duration > 0) result += encodeDuration(duration).map((length) => `r${length}`).join("");
      position = boundary;
      if (position < end) emitTempo(position);
    }
  };
  const emitNote = (item) => {
    const end = item.tick + item.duration;
    let position = item.tick;
    let hasPiece = false;
    emitTempo(position);
    const velocity = Math.max(0, Math.min(15, Math.round(item.velocity ?? 15)));
    for (const boundary of boundaries(item.tick, end)) {
      if (hasPiece) {
        result += "&";
        emitTempo(position);
      }
      if (!hasPiece && currentVelocity !== velocity) {
        result += `v${velocity}`;
        currentVelocity = velocity;
      }
      const encoded = encodeEvent(item.midi, boundary - position, currentOctave);
      result += encoded.text;
      currentOctave = encoded.octave;
      hasPiece = true;
      position = boundary;
    }
  };

  for (const item of items) {
    if (item.tick > cursor) emitRest(cursor, item.tick);
    if (item.kind === "note") emitNote(item);
    else emitRest(item.tick, item.tick + item.duration);
    cursor = Math.max(cursor, item.tick + item.duration);
  }
  const finalTempoTick = tempoTicks.at(-1) ?? 0;
  if (finalTempoTick > cursor) {
    emitRest(cursor, finalTempoTick);
    cursor = finalTempoTick;
  }
  emitTempo(cursor);
  return result;
}

export function upsertTempoCommand(source, tick, bpm) {
  const safeTick = Math.max(0, Math.round(Number(tick) || 0));
  const safeBpm = Math.max(1, Math.round(Number(bpm) || 120));
  const parsed = parseTrack(source);
  const existing = parsed.tempos.filter((event) => event.tick === safeTick);
  if (existing.length) {
    let result = source;
    for (const event of [...existing].sort((a, b) => b.sourceStart - a.sourceStart)) {
      result = `${result.slice(0, event.sourceStart)}t${safeBpm}${result.slice(event.sourceEnd)}`;
    }
    return result;
  }
  const items = [...parsed.notes, ...parsed.rests].sort((a, b) => a.tick - b.tick || a.sourceStart - b.sourceStart);
  const boundary = items.find((item) => item.tick === safeTick);
  if (boundary) return `${source.slice(0, boundary.sourceStart)}t${safeBpm}${source.slice(boundary.sourceStart)}`;
  if (safeTick === parsed.duration) return `${source}t${safeBpm}`;
  return serializeTrackWithTempos(parsed, [...parsed.tempos, { tick: safeTick, bpm: safeBpm }]);
}

export function deleteTempoCommand(source, tick) {
  const safeTick = Math.max(0, Math.round(Number(tick) || 0));
  const parsed = parseTrack(source);
  let result = source;
  for (const event of parsed.tempos.filter((item) => item.tick === safeTick).sort((a, b) => b.sourceStart - a.sourceStart)) {
    result = `${result.slice(0, event.sourceStart)}${result.slice(event.sourceEnd)}`;
  }
  return result;
}

export function mergeTempoCommands(source, events = []) {
  return normalizedTempoEvents(events).reduce(
    (result, event) => upsertTempoCommand(result, event.tick, event.bpm),
    source,
  );
}

export function tempoAtTick(tick, tempoEvents, defaultTempo = 120) {
  let bpm = defaultTempo;
  for (const event of [...tempoEvents].sort((a, b) => a.tick - b.tick)) {
    if (event.tick > tick) break;
    bpm = event.bpm;
  }
  return bpm;
}

export function mergeTempoEvents(trackEvents = [], timelineEvents = [], defaultTempo = 120) {
  const byTick = new Map();
  for (const event of [...trackEvents].sort((a, b) => a.tick - b.tick)) {
    const tick = Math.max(0, Number(event.tick) || 0);
    if (!byTick.has(tick)) byTick.set(tick, { ...event, tick, bpm: Math.max(1, Number(event.bpm) || defaultTempo) });
  }
  for (const event of [...timelineEvents].sort((a, b) => a.tick - b.tick)) {
    const tick = Math.max(0, Number(event.tick) || 0);
    byTick.set(tick, { ...event, tick, bpm: Math.max(1, Number(event.bpm) || defaultTempo), timeline: true });
  }
  if (!byTick.has(0)) byTick.set(0, { tick: 0, bpm: Math.max(1, Number(defaultTempo) || 120), timeline: true });
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

export function tickToSeconds(tick, tempoEvents, defaultTempo = 120) {
  const events = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  let cursorTick = 0;
  let seconds = 0;
  let bpm = defaultTempo;
  for (const event of events) {
    if (event.tick > tick) break;
    seconds += ((event.tick - cursorTick) / TICKS_PER_QUARTER) * (60 / bpm);
    cursorTick = event.tick;
    bpm = event.bpm;
  }
  return seconds + ((tick - cursorTick) / TICKS_PER_QUARTER) * (60 / bpm);
}

export function sourceRangeAtTick(track, tick) {
  const safeTick = Math.max(0, Number(tick) || 0);
  const items = [...(track?.notes ?? []), ...(track?.rests ?? [])]
    .sort((a, b) => a.tick - b.tick || a.sourceStart - b.sourceStart);
  const current = items.find((item) => item.tick <= safeTick && safeTick < item.tick + item.duration);
  if (!current) return null;
  return { start: current.sourceStart, end: current.sourceEnd };
}
