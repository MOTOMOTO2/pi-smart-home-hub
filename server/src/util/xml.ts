/**
 * Minimal tag-text extractor for the small, flat XML documents the Roku ECP
 * returns. Deliberately not a real parser: it only has to pull leaf text and
 * simple repeated elements, and avoiding a dependency keeps `npm ci` on a Pi
 * free of anything that needs a compiler.
 */
export function xmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m || m[1] === undefined) return undefined;
  return decodeEntities(m[1]).trim();
}

export interface XmlElement {
  attrs: Record<string, string>;
  text: string;
}

/** Every occurrence of `<tag ...>text</tag>` plus self-closing `<tag ... />`. */
export function xmlElements(xml: string, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const re = new RegExp(`<${tag}((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ attrs: parseAttrs(m[1] ?? ''), text: decodeEntities(m[2] ?? '').trim() });
  }
  return out;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1] ?? m[3];
    const value = m[2] ?? m[4] ?? '';
    if (key) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}
