import { stripComments } from "./core.js";

export const MML_NOTE_LENGTHS = [1, 2, 4, 8, 16, 32];

function numberEnd(source, start) {
  let end = start;
  while (end < source.length && /[0-9]/.test(source[end])) end += 1;
  return end;
}

function editableTokens(source) {
  const clean = stripComments(source);
  const tokens = [];
  let index = 0;
  let defaultLength = 4;
  while (index < clean.length) {
    const character = clean[index].toLowerCase();
    if (/\s/.test(character) || character === ";" || character === "&" || character === "<" || character === ">") {
      index += 1;
      continue;
    }
    if (["l", "o", "t", "v"].includes(character)) {
      const end = numberEnd(clean, index + 1);
      if (character === "l" && end > index + 1) defaultLength = Number(clean.slice(index + 1, end));
      index = Math.max(index + 1, end);
      continue;
    }
    if (character === "n") {
      index = numberEnd(clean, index + 1);
      while (clean[index] === ".") index += 1;
      continue;
    }
    if (!/[a-gr]/.test(character)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    if (character !== "r" && /[+#-]/.test(clean[index] ?? "")) index += 1;
    const headEnd = index;
    const lengthEnd = numberEnd(clean, index);
    const denominator = lengthEnd > index ? Number(clean.slice(index, lengthEnd)) : defaultLength;
    index = lengthEnd;
    let dots = 0;
    while (clean[index] === ".") {
      dots += 1;
      index += 1;
    }
    tokens.push({ start, end: index, headEnd, denominator, dots });
  }
  return tokens;
}

function replaceSelectedTokens(source, selectionStart, selectionEnd, replacementFor) {
  const start = Math.max(0, Math.min(source.length, selectionStart));
  const end = Math.max(start, Math.min(source.length, selectionEnd));
  if (start === end) return { source, selectionStart: start, selectionEnd: end, changed: 0 };
  const replacements = editableTokens(source)
    .filter((token) => token.start < end && token.end > start)
    .map((token) => ({ ...token, text: replacementFor(token) }))
    .filter((replacement) => replacement.text !== source.slice(replacement.start, replacement.end));
  if (!replacements.length) return { source, selectionStart: start, selectionEnd: end, changed: 0 };
  let nextSource = source;
  for (const replacement of [...replacements].reverse()) {
    nextSource = `${nextSource.slice(0, replacement.start)}${replacement.text}${nextSource.slice(replacement.end)}`;
  }
  const deltaBefore = (position) => replacements
    .filter((replacement) => replacement.start < position)
    .reduce((sum, replacement) => sum + replacement.text.length - (replacement.end - replacement.start), 0);
  return {
    source: nextSource,
    selectionStart: start + deltaBefore(start),
    selectionEnd: end + deltaBefore(end),
    changed: replacements.length,
  };
}

export function setSelectedMmlLength(source, selectionStart, selectionEnd, denominator, dots = 0) {
  const safeLength = Math.max(1, Math.round(Number(denominator) || 4));
  const safeDots = Math.max(0, Math.min(2, Math.round(Number(dots) || 0)));
  return replaceSelectedTokens(source, selectionStart, selectionEnd, (token) => (
    `${source.slice(token.start, token.headEnd)}${safeLength}${".".repeat(safeDots)}`
  ));
}

export function shiftSelectedMmlLength(source, selectionStart, selectionEnd, direction) {
  const step = direction < 0 ? -1 : 1;
  return replaceSelectedTokens(source, selectionStart, selectionEnd, (token) => {
    let index = MML_NOTE_LENGTHS.indexOf(token.denominator);
    if (index < 0) {
      index = MML_NOTE_LENGTHS.reduce((best, value, candidate) => (
        Math.abs(Math.log2(value / token.denominator)) < Math.abs(Math.log2(MML_NOTE_LENGTHS[best] / token.denominator)) ? candidate : best
      ), 0);
    }
    const next = MML_NOTE_LENGTHS[Math.max(0, Math.min(MML_NOTE_LENGTHS.length - 1, index + step))];
    return `${source.slice(token.start, token.headEnd)}${next}${".".repeat(token.dots)}`;
  });
}
