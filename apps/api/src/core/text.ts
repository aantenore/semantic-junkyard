import { convert } from "html-to-text";
import { DomainError } from "./errors.js";

export interface HtmlTextLimits {
  maxInputLength: number;
  maxDepth: number;
  maxChildNodes: number;
}

export const HTML_TEXT_LIMIT_BOUNDS = {
  maxInputLength: { minimum: 1_024, maximum: 5_000_000, default: 5_000_000 },
  maxDepth: { minimum: 16, maximum: 512, default: 128 },
  maxChildNodes: { minimum: 100, maximum: 50_000, default: 10_000 }
} as const;

export const DEFAULT_HTML_TEXT_LIMITS: Readonly<HtmlTextLimits> = Object.freeze({
  maxInputLength: HTML_TEXT_LIMIT_BOUNDS.maxInputLength.default,
  maxDepth: HTML_TEXT_LIMIT_BOUNDS.maxDepth.default,
  maxChildNodes: HTML_TEXT_LIMIT_BOUNDS.maxChildNodes.default
});

const HTML_LIMIT_SENTINEL = "\u0000semantic-junkyard:html-limit\u0000";

export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
  "without",
  "within",
  "will",
  "can",
  "should",
  "must",
  "we",
  "you",
  "your",
  "our",
  "they"
]);

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHtml(value: string, limits: Readonly<HtmlTextLimits> = DEFAULT_HTML_TEXT_LIMITS): string {
  const safeLimits = validateHtmlTextLimits(limits);
  if (value.length > safeLimits.maxInputLength) {
    throw new DomainError(
      "HTML_INPUT_LIMIT_EXCEEDED",
      `HTML input exceeds the configured ${safeLimits.maxInputLength}-character limit.`,
      422,
      { maxInputLength: safeLimits.maxInputLength }
    );
  }

  const text = convert(value, {
    wordwrap: false,
    limits: {
      ...safeLimits,
      ellipsis: HTML_LIMIT_SENTINEL
    },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "h5", options: { uppercase: false } },
      { selector: "h6", options: { uppercase: false } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" }
    ]
  });
  if (text.includes(HTML_LIMIT_SENTINEL)) {
    throw new DomainError(
      "HTML_STRUCTURE_LIMIT_EXCEEDED",
      "HTML structure exceeds the configured parser safety limits.",
      422,
      { maxDepth: safeLimits.maxDepth, maxChildNodes: safeLimits.maxChildNodes }
    );
  }
  return text.replaceAll("\u00a0", " ");
}

export function validateHtmlTextLimits(limits: Readonly<HtmlTextLimits>): HtmlTextLimits {
  return {
    maxInputLength: boundedInteger("maxInputLength", limits.maxInputLength, HTML_TEXT_LIMIT_BOUNDS.maxInputLength),
    maxDepth: boundedInteger("maxDepth", limits.maxDepth, HTML_TEXT_LIMIT_BOUNDS.maxDepth),
    maxChildNodes: boundedInteger("maxChildNodes", limits.maxChildNodes, HTML_TEXT_LIMIT_BOUNDS.maxChildNodes)
  };
}

function boundedInteger(
  name: keyof HtmlTextLimits,
  value: number,
  bounds: { minimum: number; maximum: number }
): number {
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new Error(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}.`);
  }
  return value;
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function summarize(value: string, maxLength = 180): string {
  const clean = normalizeWhitespace(value).replace(/\n/g, " ");
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

export function topTerms(texts: string[], limit = 12): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (token.length < 3) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}
