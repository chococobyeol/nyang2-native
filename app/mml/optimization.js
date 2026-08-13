import {
  midiToMmlNoteNumber,
  mmlNoteNumberToMidi,
  parseTrack,
  serializeTrackWithTempos,
  stripComments,
  TICKS_PER_WHOLE,
} from "./core.js";

const INITIAL_LENGTH = "4";
const INITIAL_OCTAVE = 4;
const NOTE_CLASS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const READABLE_DENOMINATORS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 384, 3, 6, 12, 24, 48, 96, 192];

function readDigits(source, start) {
  let end = start;
  while (end < source.length && /[0-9]/.test(source[end])) end += 1;
  return { text: source.slice(start, end), end };
}

function lengthKey(denominator, dots = 0) {
  return `${denominator}${".".repeat(dots)}`;
}

function compactTokens(source) {
  const clean = stripComments(source).replace(/\s+/g, "").replace(/;/g, "").toLowerCase();
  const tokens = [];
  let index = 0;
  let defaultLength = INITIAL_LENGTH;
  let currentTempo = null;
  let currentVelocity = null;
  let currentOctave = null;

  while (index < clean.length) {
    const character = clean[index];

    if (character === "l") {
      const number = readDigits(clean, index + 1);
      let dots = 0;
      while (clean[number.end + dots] === ".") dots += 1;
      defaultLength = lengthKey(number.text, dots);
      index = number.end + dots;
      continue;
    }

    if (["t", "v", "o"].includes(character)) {
      const number = readDigits(clean, index + 1);
      let value = Number(number.text);
      if (character === "v") value = Math.max(0, Math.min(15, value));
      const previous = character === "t" ? currentTempo : character === "v" ? currentVelocity : currentOctave;
      if (value !== previous) tokens.push({ kind: "fixed", text: `${character}${value}` });
      if (character === "t") currentTempo = value;
      else if (character === "v") currentVelocity = value;
      else currentOctave = value;
      index = number.end;
      continue;
    }

    if (character === "<" || character === ">") {
      if (currentOctave !== null) currentOctave += character === ">" ? 1 : -1;
      tokens.push({ kind: "fixed", text: character });
      index += 1;
      continue;
    }

    if (character === "&") {
      tokens.push({ kind: "fixed", text: character });
      index += 1;
      continue;
    }

    if (character === "n") {
      const number = readDigits(clean, index + 1);
      tokens.push({ kind: "event", base: `n${number.text}`, length: defaultLength, explicitLength: false });
      index = number.end;
      continue;
    }

    let base = character;
    index += 1;
    if (character !== "r" && ["+", "#", "-"].includes(clean[index])) {
      base += clean[index] === "#" ? "+" : clean[index];
      index += 1;
    }
    const number = readDigits(clean, index);
    index = number.end;
    let dots = 0;
    while (clean[index] === ".") {
      dots += 1;
      index += 1;
    }
    const denominator = number.text || defaultLength.replace(/\.+$/, "");
    const resolvedDots = number.text || dots > 0 ? dots : (defaultLength.match(/\.+$/)?.[0].length ?? 0);
    tokens.push({ kind: "event", base, length: lengthKey(denominator, resolvedDots), explicitLength: true });
  }

  return tokens;
}

function shortestLengthEncoding(tokens) {
  const lengths = [...new Set([INITIAL_LENGTH, ...tokens.filter((token) => token.kind === "event").map((token) => token.length)])];
  const initialIndex = lengths.indexOf(INITIAL_LENGTH);
  let costs = lengths.map(() => Number.POSITIVE_INFINITY);
  costs[initialIndex] = 0;
  const history = [];

  for (const token of tokens) {
    const nextCosts = lengths.map(() => Number.POSITIVE_INFINITY);
    const previousStates = lengths.map(() => -1);
    const pieces = lengths.map(() => "");

    if (token.kind === "fixed") {
      for (let state = 0; state < lengths.length; state += 1) {
        if (!Number.isFinite(costs[state])) continue;
        nextCosts[state] = costs[state] + token.text.length;
        previousStates[state] = state;
        pieces[state] = token.text;
      }
    } else {
      const eventLengthIndex = lengths.indexOf(token.length);
      for (let state = 0; state < lengths.length; state += 1) {
        if (!Number.isFinite(costs[state])) continue;
        if (state === eventLengthIndex) {
          nextCosts[state] = costs[state] + token.base.length;
          previousStates[state] = state;
          pieces[state] = token.base;
        } else if (token.explicitLength) {
          nextCosts[state] = costs[state] + token.base.length + token.length.length;
          previousStates[state] = state;
          pieces[state] = `${token.base}${token.length}`;
        }

        const switchedCost = costs[state] + 1 + token.length.length + token.base.length;
        if (switchedCost < nextCosts[eventLengthIndex]) {
          nextCosts[eventLengthIndex] = switchedCost;
          previousStates[eventLengthIndex] = state;
          pieces[eventLengthIndex] = `l${token.length}${token.base}`;
        }
      }
    }

    history.push({ previousStates, pieces });
    costs = nextCosts;
  }

  let state = costs.indexOf(Math.min(...costs));
  const result = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const layer = history[index];
    result.push(layer.pieces[state]);
    state = layer.previousStates[state];
  }
  return result.reverse().join("");
}

function durationCandidates(denominators) {
  const byTicks = new Map();
  for (const denominator of denominators) {
    // Mabinogi Mobile accepts a single augmentation dot. Keep longer values
    // as tied notes instead of emitting unsupported double-dotted tokens.
    for (let dots = 0; dots <= 1; dots += 1) {
      let ticks = TICKS_PER_WHOLE / denominator;
      let addition = ticks / 2;
      for (let dot = 0; dot < dots; dot += 1) {
        ticks += addition;
        addition /= 2;
      }
      if (!Number.isInteger(ticks) || ticks <= 0) continue;
      const text = lengthKey(denominator, dots);
      const previous = byTicks.get(ticks);
      if (!previous || text.length < previous.text.length) byTicks.set(ticks, { ticks, text });
    }
  }
  return [...byTicks.values()].sort((a, b) => b.ticks - a.ticks || a.text.length - b.text.length);
}

const COMPACT_DURATION_CANDIDATES = durationCandidates(Array.from({ length: 384 }, (_, index) => index + 1));
const READABLE_DURATION_CANDIDATES = durationCandidates(READABLE_DENOMINATORS);
const durationCache = new Map();

function durationParts(duration, mode, baseLength, tied) {
  const ticks = Math.round(duration);
  if (!Number.isFinite(duration) || ticks <= 0 || Math.abs(duration - ticks) > 0.0001) return null;
  const cacheKey = `${mode}|${baseLength}|${tied ? 1 : 0}|${ticks}`;
  if (durationCache.has(cacheKey)) return durationCache.get(cacheKey);
  const candidates = mode === "readable" ? READABLE_DURATION_CANDIDATES : COMPACT_DURATION_CANDIDATES;
  const separatorLength = tied ? 1 : 0;
  const best = Array(ticks + 1).fill(null);
  best[0] = { cost: 0, count: 0, previous: -1, text: "" };

  for (let total = 1; total <= ticks; total += 1) {
    for (const candidate of candidates) {
      if (candidate.ticks > total || !best[total - candidate.ticks]) continue;
      const previous = best[total - candidate.ticks];
      const next = {
        cost: previous.cost + candidate.text.length + baseLength + separatorLength,
        count: previous.count + 1,
        previous: total - candidate.ticks,
        text: candidate.text,
      };
      const current = best[total];
      const better = mode === "readable"
        ? !current || next.count < current.count || (next.count === current.count && next.cost < current.cost)
        : !current || next.cost < current.cost || (next.cost === current.cost && next.count < current.count);
      if (better) best[total] = next;
    }
  }

  if (!best[ticks]) return null;
  const parts = [];
  let cursor = ticks;
  while (cursor > 0) {
    const item = best[cursor];
    parts.push(item.text);
    cursor = item.previous;
  }
  parts.reverse();
  durationCache.set(cacheKey, parts);
  return parts;
}

function serializeParsedTrack(parsed, mode) {
  const tempos = effectiveTempos(parsed.tempos);
  const tempoByTick = new Map(tempos.map((event) => [event.tick, event.bpm]));
  const tempoTicks = tempos.map((event) => event.tick);
  const emittedTempos = new Set();
  const items = [...parsed.notes.map((item) => ({ ...item, kind: "note" })), ...parsed.rests.map((item) => ({ ...item, kind: "rest" }))]
    .sort((a, b) => a.tick - b.tick || a.sourceStart - b.sourceStart);
  let result = "";
  let cursor = 0;
  let currentVelocity = null;
  let currentOctave = INITIAL_OCTAVE;

  const emitTempo = (tick) => {
    if (!tempoByTick.has(tick) || emittedTempos.has(tick)) return;
    result += `t${tempoByTick.get(tick)}`;
    emittedTempos.add(tick);
  };
  const boundaries = (start, end) => [...tempoTicks.filter((tick) => tick > start && tick < end), end];
  const emitRest = (start, end) => {
    let position = start;
    emitTempo(position);
    for (const boundary of boundaries(start, end)) {
      const duration = boundary - position;
      if (duration > 0) {
        const lengths = durationParts(duration, mode, 1, false);
        if (!lengths) return false;
        result += lengths.map((length) => `r${length}`).join("");
      }
      position = boundary;
      if (position < end) emitTempo(position);
    }
    return true;
  };
  const emitNote = (item) => {
    const end = item.tick + item.duration;
    let position = item.tick;
    let hasPiece = false;
    emitTempo(position);
    const velocity = Math.max(0, Math.min(15, Math.round(item.velocity ?? 15)));
    const targetOctave = Math.floor(item.midi / 12) - 1;
    const noteName = NOTE_NAMES[((item.midi % 12) + 12) % 12];
    for (const boundary of boundaries(item.tick, end)) {
      if (hasPiece) {
        result += "&";
        emitTempo(position);
      }
      if (!hasPiece && currentVelocity !== velocity) {
        result += `v${velocity}`;
        currentVelocity = velocity;
      }
      const lengths = durationParts(boundary - position, mode, noteName.length, true);
      if (!lengths || targetOctave < 0) return false;
      const prefix = targetOctave === currentOctave ? "" : `o${targetOctave}`;
      result += lengths.map((length, index) => `${index === 0 ? prefix : ""}${noteName}${length}`).join("&");
      currentOctave = targetOctave;
      hasPiece = true;
      position = boundary;
    }
    return true;
  };

  for (const item of items) {
    if (item.tick > cursor && !emitRest(cursor, item.tick)) return null;
    if (item.kind === "note") {
      if (!emitNote(item)) return null;
    } else if (!emitRest(item.tick, item.tick + item.duration)) return null;
    cursor = Math.max(cursor, item.tick + item.duration);
  }
  const finalTempoTick = tempoTicks.at(-1) ?? 0;
  if (finalTempoTick > cursor) {
    if (!emitRest(cursor, finalTempoTick)) return null;
    cursor = finalTempoTick;
  }
  emitTempo(cursor);
  return result;
}

function semanticTokens(source) {
  const clean = source.replace(/\s+/g, "").toLowerCase();
  const tokens = [];
  let index = 0;
  let octave = INITIAL_OCTAVE;
  let defaultLength = INITIAL_LENGTH;

  while (index < clean.length) {
    const character = clean[index];
    if (["t", "v", "o", "l"].includes(character)) {
      const number = readDigits(clean, index + 1);
      let dots = 0;
      if (character === "l") while (clean[number.end + dots] === ".") dots += 1;
      const text = `${character}${number.text}${".".repeat(dots)}`;
      if (character === "o") octave = Number(number.text);
      else if (character === "l") defaultLength = lengthKey(number.text, dots);
      else tokens.push({ kind: "fixed", text });
      index = number.end + dots;
      continue;
    }
    if (character === "<" || character === ">") {
      octave += character === ">" ? 1 : -1;
      index += 1;
      continue;
    }
    if (character === "&") {
      tokens.push({ kind: "fixed", text: "&" });
      index += 1;
      continue;
    }
    if (character === "n") {
      const number = readDigits(clean, index + 1);
      tokens.push({ kind: "note", midi: mmlNoteNumberToMidi(Number(number.text)), length: defaultLength });
      index = number.end;
      continue;
    }

    const isRest = character === "r";
    let accidental = 0;
    index += 1;
    if (!isRest && ["+", "#", "-"].includes(clean[index])) {
      accidental = clean[index] === "-" ? -1 : 1;
      index += 1;
    }
    const number = readDigits(clean, index);
    index = number.end;
    let dots = 0;
    while (clean[index] === ".") {
      dots += 1;
      index += 1;
    }
    const denominator = number.text || defaultLength.replace(/\.+$/, "");
    const resolvedDots = number.text || dots > 0 ? dots : (defaultLength.match(/\.+$/)?.[0].length ?? 0);
    const length = lengthKey(denominator, resolvedDots);
    if (isRest) tokens.push({ kind: "rest", length });
    else tokens.push({ kind: "note", midi: 12 * (octave + 1) + NOTE_CLASS[character] + accidental, length });
  }
  return tokens;
}

function stateKey(octave, length) {
  return `${octave}|${length}`;
}

function decodeState(key) {
  const split = key.indexOf("|");
  return { octave: Number(key.slice(0, split)), length: key.slice(split + 1) };
}

function octavePrefix(current, target) {
  const difference = target - current;
  const relative = difference === 0 ? "" : (difference > 0 ? ">" : "<").repeat(Math.abs(difference));
  const absolute = `o${target}`;
  return relative.length <= absolute.length ? relative : absolute;
}

function namedPitchOptions(midi) {
  const options = [];
  for (const [name, pitchClass] of Object.entries(NOTE_CLASS)) {
    for (const accidental of [-1, 0, 1]) {
      const octave = (midi - pitchClass - accidental) / 12 - 1;
      if (!Number.isInteger(octave) || octave < 0) continue;
      options.push({
        octave,
        name: `${name}${accidental < 0 ? "-" : accidental > 0 ? "+" : ""}`,
      });
    }
  }
  return options;
}

function updateBest(map, key, candidate) {
  const previous = map.get(key);
  if (!previous
    || candidate.cost < previous.cost
    || (candidate.cost === previous.cost && candidate.nCount < previous.nCount)) {
    map.set(key, candidate);
  }
}

function addLengthChoices(next, previousKey, previous, octave, currentLength, eventLength, prefix, base, nCount, explicitLength) {
  if (currentLength === eventLength) {
    const piece = `${prefix}${base}`;
    updateBest(next, stateKey(octave, currentLength), {
      cost: previous.cost + piece.length,
      nCount: previous.nCount + nCount,
      previousKey,
      piece,
    });
  } else if (explicitLength) {
    const piece = `${prefix}${base}${eventLength}`;
    updateBest(next, stateKey(octave, currentLength), {
      cost: previous.cost + piece.length,
      nCount: previous.nCount + nCount,
      previousKey,
      piece,
    });
  }

  const switchedPiece = `l${eventLength}${prefix}${base}`;
  updateBest(next, stateKey(octave, eventLength), {
    cost: previous.cost + switchedPiece.length,
    nCount: previous.nCount + nCount,
    previousKey,
    piece: switchedPiece,
  });
}

function shortestSemanticEncoding(tokens) {
  let states = new Map([[stateKey(INITIAL_OCTAVE, INITIAL_LENGTH), {
    cost: 0,
    nCount: 0,
    previousKey: null,
    piece: "",
  }]]);
  const history = [];

  for (const token of tokens) {
    const next = new Map();
    for (const [previousKey, previous] of states) {
      const { octave, length } = decodeState(previousKey);
      if (token.kind === "fixed") {
        updateBest(next, previousKey, {
          cost: previous.cost + token.text.length,
          nCount: previous.nCount,
          previousKey,
          piece: token.text,
        });
        continue;
      }
      if (token.kind === "rest") {
        addLengthChoices(next, previousKey, previous, octave, length, token.length, "", "r", 0, true);
        continue;
      }

      for (const pitch of namedPitchOptions(token.midi)) {
        addLengthChoices(
          next,
          previousKey,
          previous,
          pitch.octave,
          length,
          token.length,
          octavePrefix(octave, pitch.octave),
          pitch.name,
          0,
          true,
        );
      }
      const mmlNoteNumber = midiToMmlNoteNumber(token.midi);
      if (mmlNoteNumber >= 0) {
        addLengthChoices(next, previousKey, previous, octave, length, token.length, "", `n${mmlNoteNumber}`, 1, false);
      }
    }
    history.push(next);
    states = next;
  }

  let finalKey = null;
  let final = null;
  for (const [key, value] of states) {
    if (!final || value.cost < final.cost || (value.cost === final.cost && value.nCount < final.nCount)) {
      finalKey = key;
      final = value;
    }
  }
  if (!final || finalKey === null) return "";

  const pieces = [];
  let key = finalKey;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const node = history[index].get(key);
    pieces.push(node.piece);
    key = node.previousKey;
  }
  return pieces.reverse().join("");
}

function effectiveTempos(tempos) {
  const byTick = new Map();
  for (const tempo of tempos) byTick.set(tempo.tick, tempo.bpm);
  const result = [];
  for (const [tick, bpm] of [...byTick].sort((a, b) => a[0] - b[0])) {
    if (result.at(-1)?.bpm !== bpm) result.push({ tick, bpm });
  }
  return result;
}

function musicalFingerprint(parsed) {
  return JSON.stringify({
    duration: parsed.duration,
    notes: parsed.notes.map(({ tick, duration, midi, velocity }) => ({ tick, duration, midi, velocity })),
    tempos: effectiveTempos(parsed.tempos),
  });
}

function verifyEquivalent(before, candidate) {
  try {
    return musicalFingerprint(before) === musicalFingerprint(parseTrack(candidate));
  } catch {
    return false;
  }
}

function lexicalTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index].toLowerCase();
    if (/\s/.test(character) || character === ";") {
      index += 1;
      continue;
    }
    if (["<", ">", "&"].includes(character)) {
      tokens.push(character);
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    if (["t", "v", "o", "l", "n"].includes(character)) {
      const number = readDigits(source, index);
      index = number.end;
      if (character === "l") while (source[index] === ".") index += 1;
    } else {
      if (character !== "r" && ["+", "#", "-"].includes(source[index])) index += 1;
      const number = readDigits(source, index);
      index = number.end;
      while (source[index] === ".") index += 1;
    }
    tokens.push(source.slice(start, index).toLowerCase().replace("#", "+"));
  }
  return tokens;
}

function formatReadable(source) {
  const tokens = lexicalTokens(source);
  const lines = [];
  let line = "";
  let events = 0;
  const flush = () => {
    if (line.length) lines.push(line);
    line = "";
    events = 0;
  };

  for (const token of tokens) {
    const isEvent = /^[a-grn]/.test(token);
    const isTempo = /^t/.test(token);
    if ((isTempo && line.length && events > 0) || (isEvent && events >= 16) || (line.length + token.length > 88)) flush();
    line += token;
    if (isEvent) events += 1;
  }
  flush();
  return lines.join("\n");
}

export function optimizeMmlText(source) {
  const original = String(source ?? "");
  const before = parseTrack(original);
  const canonical = serializeParsedTrack(before, "compact") ?? serializeTrackWithTempos(before, before.tempos);
  const baseline = stripComments(original).replace(/\s+/g, "").replace(/;/g, "").toLowerCase().replace(/#/g, "+");
  const candidates = [
    baseline,
    shortestLengthEncoding(compactTokens(original)),
    shortestSemanticEncoding(semanticTokens(canonical)),
  ].filter((candidate, index, values) => candidate
    && !candidate.includes("..")
    && values.indexOf(candidate) === index
    && verifyEquivalent(before, candidate));
  if (!candidates.length) throw new Error("원래 연주와 같은 최적화 결과를 만들지 못했습니다.");
  const optimized = candidates.reduce((shortest, candidate) => candidate.length < shortest.length ? candidate : shortest);
  return {
    source: optimized,
    changed: optimized !== original,
    beforeLength: original.length,
    afterLength: optimized.length,
    saved: Math.max(0, original.length - optimized.length),
  };
}

export function expandMmlText(source) {
  const original = String(source ?? "");
  const before = parseTrack(original);
  const canonical = serializeParsedTrack(before, "readable") ?? serializeTrackWithTempos(before, before.tempos);
  const readable = formatReadable(canonical);
  if (!verifyEquivalent(before, readable)) {
    throw new Error("원래 연주와 같은 읽기용 MML을 만들지 못했습니다.");
  }
  return {
    source: readable,
    changed: readable !== original,
    beforeLength: original.length,
    afterLength: readable.length,
  };
}
