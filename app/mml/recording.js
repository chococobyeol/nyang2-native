import { serializeTrackEvents, tickToSeconds, TICKS_PER_QUARTER } from "./core.js";

export function resolveRecordingStartTick(mode, currentTick, trackDurations = [], routedTrackIndexes = []) {
  if (mode === "beginning") return 0;
  if (mode === "empty") {
    const indexes = [...new Set(routedTrackIndexes)]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value < trackDurations.length);
    return Math.max(0, ...indexes.map((index) => Number(trackDurations[index]) || 0));
  }
  return Math.max(0, Number(currentTick) || 0);
}

export function elapsedSecondsToTicks(startTick, elapsedSeconds, tempoEvents = [], defaultTempo = 120) {
  const safeStartTick = Math.max(0, Number(startTick) || 0);
  const safeElapsed = Math.max(0, Number(elapsedSeconds) || 0);
  if (safeElapsed === 0) return 0;
  const targetSeconds = tickToSeconds(safeStartTick, tempoEvents, defaultTempo) + safeElapsed;
  let low = safeStartTick;
  let high = safeStartTick + TICKS_PER_QUARTER * 4;
  while (tickToSeconds(high, tempoEvents, defaultTempo) < targetSeconds) high += Math.max(TICKS_PER_QUARTER * 4, high - safeStartTick);
  for (let index = 0; index < 36; index += 1) {
    const middle = (low + high) / 2;
    if (tickToSeconds(middle, tempoEvents, defaultTempo) < targetSeconds) low = middle;
    else high = middle;
  }
  return Math.max(0, (low + high) / 2 - safeStartTick);
}

export const QUANTIZE_TICKS = {
  "1/1": 384,
  "1/2": 192,
  "1/4": 96,
  "1/8": 48,
  "1/16": 24,
  "1/32": 12,
  off: 1,
};

export function quantizationGridTicks(division) {
  if (division === "off") return null;
  if (division === "auto") return 12;
  return QUANTIZE_TICKS[division] ?? QUANTIZE_TICKS["1/8"];
}

export function snapTickToGrid(tick, division = "1/8") {
  const grid = quantizationGridTicks(division);
  const safeTick = Math.max(0, Number(tick) || 0);
  return grid ? Math.round(safeTick / grid) * grid : Math.round(safeTick);
}

export function liveInputTicks(input, endedAt, bpm, origin = 0, startTick = 0) {
  const ticksPerSecond = (TICKS_PER_QUARTER * bpm) / 60;
  const tick = startTick + Math.max(0, (input.startedAt - origin) * ticksPerSecond);
  const duration = Math.max(1, (Math.max(input.startedAt, endedAt) - input.startedAt) * ticksPerSecond);
  return { tick, duration };
}

export function liveNotesEndTick(notes, fallbackTick = 0) {
  if (!notes.length) return Math.max(0, Math.round(fallbackTick));
  return Math.max(0, Math.round(Math.max(...notes.map((note) => note.tick + note.duration))));
}

export function appendLegatoContinuation(completedInputs, activeInputs, bpm, division = "1/8") {
  if (!completedInputs.length || activeInputs.length !== 1) return null;
  const previous = completedInputs.at(-1);
  const next = activeInputs[0];
  const ticksPerSecond = (TICKS_PER_QUARTER * bpm) / 60;
  const attackGapTicks = (next.startedAt - previous.startedAt) * ticksPerSecond;
  const overlapTicks = (previous.endedAt - next.startedAt) * ticksPerSecond;
  const toleranceTicks = division === "off"
    ? 12
    : division === "auto"
      ? 48
      : quantizationGridTicks(division) ?? 48;
  if (attackGapTicks <= 6 || overlapTicks <= 0 || overlapTicks >= toleranceTicks) return null;
  return {
    inputId: next.inputId,
    settledTick: quantizedInputsEndTick(completedInputs, bpm, division, 0),
  };
}

export function nextMetronomeBeatAt(clock, now) {
  if (!clock || !(clock.beatSeconds > 0)) return now;
  if (now <= clock.startAt) return clock.startAt;
  return clock.startAt + Math.ceil((now - clock.startAt) / clock.beatSeconds) * clock.beatSeconds;
}

export function syncedPlaybackStartAt(metronomeEnabled, clock, now, options = {}) {
  if (!metronomeEnabled || !clock) return now;
  const numerator = Math.max(1, Number(options.timeSignature?.numerator) || 4);
  const denominator = Math.max(1, Number(options.timeSignature?.denominator) || 4);
  const startTick = Math.max(0, Number(options.startTick) || 0);
  const meterStartTick = Math.max(0, Number(options.meterStartTick) || 0);
  const safetySeconds = Math.max(0, Number(options.safetySeconds) || 0.02);
  const ticksPerBeat = (TICKS_PER_QUARTER * 4) / denominator;
  const beatPosition = Math.max(0, startTick - meterStartTick) / ticksPerBeat;
  const phase = ((beatPosition % numerator) + numerator) % numerator;
  const phaseStartAt = clock.startAt + phase * clock.beatSeconds;
  const target = now + safetySeconds;
  if (target <= phaseStartAt) return phaseStartAt;
  const measureSeconds = clock.beatSeconds * numerator;
  return phaseStartAt + Math.ceil((target - phaseStartAt) / measureSeconds) * measureSeconds;
}

export function recordingStartPlan({ mode, countIn, now, bpm, timeSignature, metronomeClock = /** @type {{ startAt: number, beatSeconds: number } | null} */ (null) }) {
  if (mode === "append") return { plannedStart: now, waitsForStart: false };
  const beatSeconds = metronomeClock?.beatSeconds ?? (60 / bpm) * (4 / timeSignature.denominator);
  const countBeats = Math.max(0, countIn) * timeSignature.numerator;
  const firstBeat = metronomeClock ? nextMetronomeBeatAt(metronomeClock, now + 0.02) : now;
  const plannedStart = firstBeat + countBeats * beatSeconds;
  return { plannedStart, waitsForStart: plannedStart > now + 0.01 };
}

export function countInBeats(plannedStart, bpm, timeSignature, countIn) {
  const numerator = Math.max(1, Number(timeSignature?.numerator) || 4);
  const denominator = Math.max(1, Number(timeSignature?.denominator) || 4);
  const beatSeconds = (60 / Math.max(1, bpm)) * (4 / denominator);
  const count = Math.max(0, Number(countIn) || 0) * numerator;
  const firstAt = plannedStart - count * beatSeconds;
  return Array.from({ length: count }, (_, index) => ({
    at: firstAt + index * beatSeconds,
    beat: index % numerator,
    count: numerator,
    accent: index % numerator === 0,
  }));
}

export function armedInputStartAt(mode, plannedStart, pressedAt) {
  return mode === "append" ? 0 : Math.max(plannedStart, pressedAt);
}

export function recordingInputEndAt(mode, wallEndedAt, appendCursor = 0, appendWallStart = /** @type {number | null} */ (null)) {
  if (mode !== "append") return wallEndedAt;
  return appendCursor + Math.max(0, wallEndedAt - (appendWallStart ?? wallEndedAt));
}

const AUTO_GRIDS = [96, 48, 32, 24, 16, 12];

function autoQuantizeTick(value) {
  let best = { value: Math.round(value), score: Infinity };
  for (const grid of AUTO_GRIDS) {
    const candidate = Math.round(value / grid) * grid;
    const complexityPenalty = (48 / grid) * 1.5;
    const score = Math.abs(candidate - value) + complexityPenalty;
    if (score < best.score) best = { value: candidate, score };
  }
  return best.value;
}

function nearestFixedDuration(rawDuration, grid) {
  const safeDuration = Math.max(0, rawDuration);
  const shorter = Math.max(grid, Math.floor(safeDuration / grid) * grid);
  const longer = shorter + grid;
  return safeDuration - shorter <= longer - safeDuration ? shorter : longer;
}

export function quantizeInputs(inputs, bpm, division = "1/8", origin = /** @type {number | null} */ (null)) {
  if (!inputs.length) return [];
  const start = origin ?? Math.min(...inputs.map((input) => input.startedAt));
  const ticksPerSecond = (TICKS_PER_QUARTER * bpm) / 60;
  const grid = QUANTIZE_TICKS[division] ?? QUANTIZE_TICKS["1/8"];
  return inputs.map((input) => {
    const rawStart = Math.max(0, (input.startedAt - start) * ticksPerSecond);
    const rawEnd = Math.max(rawStart, (input.endedAt - start) * ticksPerSecond);
    const rawDuration = Math.max(0, rawEnd - rawStart);
    const tick = division === "off" ? Math.round(rawStart) : division === "auto" ? autoQuantizeTick(rawStart) : Math.round(rawStart / grid) * grid;
    const minimum = division === "off" ? 1 : division === "auto" ? 12 : grid;
    const durationByLength = division === "off"
      ? Math.round(rawDuration)
      : division === "auto"
        ? autoQuantizeTick(rawDuration)
        : nearestFixedDuration(rawDuration, grid);
    const duration = Math.max(minimum, durationByLength);
    return {
      ...input,
      tick,
      duration,
      rawTick: rawStart,
      rawDuration,
    };
  });
}

export function quantizedInputsEndTick(inputs, bpm, division = "1/8", origin = /** @type {number | null} */ (null)) {
  return Math.max(0, ...quantizeInputs(inputs, bpm, division, origin).map((input) => input.tick + input.duration));
}

function overlapTolerances(division) {
  const snapped = division === "off"
    ? 12
    : division === "auto"
      ? 48
      : QUANTIZE_TICKS[division] ?? QUANTIZE_TICKS["1/8"];
  return { snapped, raw: snapped };
}

/**
 * A keyboard player will commonly press the next melody note just before
 * releasing the previous one. Keep the first note's quantized value and move
 * the next attack to its end when the real overlap is shorter than one selected
 * grid unit. Simultaneous attacks and longer overlaps remain polyphonic.
 */
export function closeShortLegatoOverlaps(inputs, division = "1/8") {
  const normalized = inputs.map((input) => ({ ...input }));
  const tolerance = overlapTolerances(division);

  for (const side of ["left", "right"]) {
    const notes = normalized
      .filter((input) => input.side === side)
      .sort((a, b) => a.tick - b.tick || a.rawTick - b.rawTick || a.midi - b.midi);
    const onsetGroups = [];
    for (const note of notes) {
      const group = onsetGroups.at(-1);
      if (group?.tick === note.tick) group.notes.push(note);
      else onsetGroups.push({ tick: note.tick, notes: [note] });
    }

    for (let index = 0; index < onsetGroups.length - 1; index += 1) {
      const current = onsetGroups[index];
      const next = onsetGroups[index + 1];
      if (current.notes.length !== 1 || next.notes.length !== 1) continue;
      const note = current.notes[0];
      const nextRawTick = Math.min(...next.notes.map((note) => note.rawTick));
      const snappedOverlap = note.tick + note.duration - next.tick;
      const rawOverlap = note.rawTick + note.rawDuration - nextRawTick;
      const separateAttack = nextRawTick - note.rawTick > 6;
      if (separateAttack && snappedOverlap > 0 && snappedOverlap <= tolerance.snapped && rawOverlap > 0 && rawOverlap < tolerance.raw) {
        next.tick += snappedOverlap;
        next.notes.forEach((nextNote) => { nextNote.tick += snappedOverlap; });
      }
    }
  }

  return normalized;
}

function overlaps(a, b) {
  return a.tick < b.tick + b.duration && b.tick < a.tick + a.duration;
}

function connectedComponents(notes) {
  const remaining = new Set(notes.map((_, index) => index));
  const components = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const queue = [seed];
    const component = [];
    while (queue.length) {
      const index = queue.pop();
      component.push(notes[index]);
      for (const candidate of [...remaining]) {
        if (component.some((note) => overlaps(note, notes[candidate]))) {
          remaining.delete(candidate);
          queue.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

export function allocateInputs(inputs, routing, pitchPriority = "high") {
  const assigned = [];
  const dropped = [];
  const trackOrder = [...new Set([...routing.left, ...routing.right])];

  for (const component of connectedComponents(inputs)) {
    const ordered = [...component].sort((a, b) => {
      const aCount = routing[a.side]?.length ?? 0;
      const bCount = routing[b.side]?.length ?? 0;
      if (aCount !== bCount) return aCount - bCount;
      return pitchPriority === "high" ? b.midi - a.midi : a.midi - b.midi;
    });
    let best = { assignments: [], count: -1, score: -Infinity };
    const occupied = new Map();
    const current = [];

    const search = (index) => {
      if (index === ordered.length) {
        const score = current.reduce((sum, item) => {
          const pitchRank = pitchPriority === "high" ? item.input.midi : -item.input.midi;
          return sum + pitchRank * 0.001 - trackOrder.indexOf(item.trackId) * 0.000001;
        }, 0);
        if (current.length > best.count || (current.length === best.count && score > best.score)) {
          best = { assignments: current.map((item) => ({ ...item })), count: current.length, score };
        }
        return;
      }
      if (current.length + (ordered.length - index) < best.count) return;
      const input = ordered[index];
      for (const trackId of routing[input.side] ?? []) {
        const trackNotes = occupied.get(trackId) ?? [];
        if (trackNotes.some((note) => overlaps(note, input))) continue;
        trackNotes.push(input);
        occupied.set(trackId, trackNotes);
        current.push({ input, trackId });
        search(index + 1);
        current.pop();
        trackNotes.pop();
      }
      search(index + 1);
    };
    search(0);
    const used = new Set(best.assignments.map((item) => item.input.id));
    assigned.push(...best.assignments);
    dropped.push(...component.filter((input) => !used.has(input.id)));
  }
  return { assigned, dropped };
}

export function recordingToTrackTexts(inputs, tracks, routing, options = {}) {
  const quantized = quantizeInputs(inputs, options.bpm ?? 120, options.quantize ?? "1/8", options.origin ?? null);
  const normalized = closeShortLegatoOverlaps(quantized, options.quantize ?? "1/8");
  const allocation = allocateInputs(normalized, routing, options.pitchPriority ?? "high");
  const byTrack = new Map(tracks.map((track) => [track.id, []]));
  for (const { input, trackId } of allocation.assigned) {
    const track = tracks.find((candidate) => candidate.id === trackId);
    const capturedVelocity = input.velocityByTrack?.[trackId];
    byTrack.get(trackId)?.push({
      tick: input.tick,
      duration: input.duration,
      midi: input.midi,
      velocity: Number.isFinite(capturedVelocity) ? capturedVelocity : (track?.recordVelocity ?? 15),
    });
  }
  return {
    texts: new Map(tracks.map((track) => [track.id, serializeTrackEvents(byTrack.get(track.id) ?? [], { velocity: track.recordVelocity ?? 15 })])),
    usedTrackIds: new Set(allocation.assigned.map((item) => item.trackId)),
    dropped: allocation.dropped,
    assigned: allocation.assigned,
    endTick: Math.max(0, ...normalized.map((input) => input.tick + input.duration)),
  };
}
