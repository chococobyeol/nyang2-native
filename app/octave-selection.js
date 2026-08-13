/**
 * Chooses the octave for a newly enabled right-hand keyboard.
 * Octave 5 is preferred; custom presets without 5 fall back to their first
 * visible button so the selected octave is never hidden.
 *
 * @param {readonly number[]} rightPresets
 */
export function chooseSecondKeyboardOctave(rightPresets) {
  return rightPresets.includes(5) ? 5 : rightPresets[0];
}
