// Dependency-free RSS 2.0 + Atom 1.0 parser for the Cloudflare Workers runtime.
// Workers have no DOMParser and HTMLRewriter is an HTML (not XML) parser, so we
// use a small purpose-built string parser. Robust for well-formed real feeds.

export interface FeedItem {
  title: string;
  link: string;
  publishedAt: Date | null;
  summary: string;
}

const ITEM_BLOCK_RE = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;

export function splitItems(xml: string): string[] {
  const blocks: string[] = [];
  for (const m of xml.matchAll(ITEM_BLOCK_RE)) {
    blocks.push(m[2]);
  }
  return blocks;
}

function escapeTagName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCData(text: string): string {
  if (text.indexOf("<![CDATA[") === -1) return text;
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function getTagContent(block: string, tagName: string): string | null {
  const tn = escapeTagName(tagName);
  const selfClosing = new RegExp(`<${tn}(?:\\s[^>]*)?/>`, "i");
  const paired = new RegExp(`<${tn}(?:\\s[^>]*)?>([\\s\\S]*?)</${tn}\\s*>`, "i");

  const pm = paired.exec(block);
  if (pm) return stripCData(pm[1]).trim();
  if (selfClosing.test(block)) return "";
  return null;
}

const ATOM_LINK_RE = /<link\b([^>]*?)\/?>/gi;
const attrRe = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");

function getAttr(attrs: string, name: string): string | null {
  const m = attrRe(name).exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? "";
}

export function getLink(block: string): string {
  const candidates: Array<{ href: string; rel: string }> = [];
  for (const m of block.matchAll(ATOM_LINK_RE)) {
    const href = getAttr(m[1], "href");
    if (href) {
      candidates.push({ href: href.trim(), rel: (getAttr(m[1], "rel") ?? "").toLowerCase() });
    }
  }
  if (candidates.length) {
    const preferred =
      candidates.find((c) => c.rel === "alternate") ??
      candidates.find((c) => c.rel === "") ??
      candidates[0];
    return decodeEntities(preferred.href);
  }

  const rss = getTagContent(block, "link");
  if (rss) return decodeEntities(rss);

  const guid = getTagContent(block, "guid");
  if (guid && /^https?:\/\//i.test(guid)) return decodeEntities(guid);
  const id = getTagContent(block, "id");
  if (id && /^https?:\/\//i.test(id)) return decodeEntities(id);

  return "";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

export function decodeEntities(input: string): string {
  if (input.indexOf("&") === -1) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : whole;
  });
}

export function stripHtml(html: string): string {
  if (!html) return "";
  let text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return collapseWhitespace(text);
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);

  const cleaned = s.replace(/\s+/g, " ");
  const t2 = Date.parse(cleaned);
  if (!Number.isNaN(t2)) return new Date(t2);

  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    const d = new Date(`${cleaned}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function firstPresent(block: string, tags: string[]): string | null {
  for (const tag of tags) {
    const v = getTagContent(block, tag);
    if (v !== null && v !== "") return v;
  }
  return null;
}

export function normalizeItem(block: string): FeedItem {
  const titleRaw = getTagContent(block, "title") ?? "";
  const summaryRaw =
    firstPresent(block, [
      "description",
      "summary",
      "content:encoded",
      "content",
      "media:description",
    ]) ?? "";
  const dateRaw = firstPresent(block, ["pubDate", "published", "updated", "dc:date", "date"]);

  return {
    title: collapseWhitespace(decodeEntities(stripCData(titleRaw))),
    link: getLink(block),
    publishedAt: parseDate(dateRaw),
    summary: stripHtml(summaryRaw),
  };
}

export function parseFeed(xml: string): FeedItem[] {
  return splitItems(xml).map(normalizeItem);
}

// Best-effort feed title for labelling the source.
export function getFeedTitle(xml: string): string {
  // The first <title> outside an <item>/<entry> is the channel/feed title.
  const withoutItems = xml.replace(ITEM_BLOCK_RE, "");
  const t = getTagContent(withoutItems, "title");
  return t ? collapseWhitespace(decodeEntities(stripCData(t))) : "";
}
