import { parseTrack, stripComments } from "./core.js";

const THREE_MLE_ENCODING = /^(?:ks_c_5601-1987|euc-kr|ks_c_5601|cp949|windows-949)$/i;

function normalizeDocument(source) {
  return String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function isThreeMleDocument(source) {
  const text = normalizeDocument(source);
  return /^\s*\[Settings\]\s*$/im.test(text) && /^\s*\[Channel\d+\]\s*$/im.test(text);
}

export function decodeThreeMleFile(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const header = new TextDecoder("windows-1252").decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  const encoding = /^\s*Encoding\s*=\s*([^\r\n]+)\s*$/im.exec(header)?.[1]?.trim() ?? "";
  const decoder = THREE_MLE_ENCODING.test(encoding) ? new TextDecoder("euc-kr") : new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

export function parseThreeMleDocument(source) {
  const text = normalizeDocument(source);
  if (!isThreeMleDocument(text)) throw new Error("3MLE MML 형식이 아닙니다.");

  const settings = {};
  const channels = [];
  let section = "";
  let channelNumber = null;
  let channelLines = [];

  const finishChannel = () => {
    if (channelNumber == null) return;
    // 3MLE wraps long tracks at arbitrary columns, including between a command
    // and its number. Comments are removed before all layout whitespace.
    const sourceText = stripComments(channelLines.join("\n")).replace(/\s+/g, "");
    if (sourceText) {
      try {
        parseTrack(sourceText);
      } catch (error) {
        throw new Error(`Channel ${channelNumber}: ${error.message}`);
      }
      channels.push({
        number: channelNumber,
        name: `Channel ${channelNumber}`,
        sourceText,
      });
    }
    channelNumber = null;
    channelLines = [];
  };

  for (const line of text.split("\n")) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      finishChannel();
      section = sectionMatch[1].trim();
      const channelMatch = /^Channel(\d+)$/i.exec(section);
      channelNumber = channelMatch ? Number(channelMatch[1]) : null;
      continue;
    }

    if (channelNumber != null) {
      channelLines.push(line);
      continue;
    }
    if (section.toLowerCase() !== "settings") continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    settings[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  finishChannel();

  if (!channels.length) throw new Error("불러올 3MLE 채널이 없습니다.");
  channels.sort((left, right) => left.number - right.number);
  return {
    format: "3mle",
    title: settings.title ?? "",
    source: settings.source ?? "",
    memo: settings.memo ?? "",
    encoding: settings.encoding ?? "",
    channels,
  };
}
