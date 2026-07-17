import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import { DEFAULT_HTML_TEXT_LIMITS, normalizeWhitespace, stripHtml } from "./text.js";

describe("stripHtml", () => {
  it("uses a parser to remove executable and style content while preserving visible text", () => {
    const html = `
      <main>
        <h1>Agent &amp; architecture</h1>
        <script>throw new Error("must not become searchable")</script>
        <style>.hidden { display: none }</style>
        <p>Local&nbsp;first</p>
      </main>
    `;

    const text = normalizeWhitespace(stripHtml(html));

    expect(text).toContain("Agent & architecture");
    expect(text).toContain("Local first");
    expect(text).not.toContain("must not become searchable");
    expect(text).not.toContain("display: none");
  });

  it("handles malformed tags and ignores link destinations and image metadata", () => {
    const text = normalizeWhitespace(
      stripHtml('<p>Visible <a href="https://example.invalid/secret">label</a><img alt="hidden" src="x"><b>tail')
    );

    expect(text).toContain("Visible");
    expect(text).toContain("label");
    expect(text).toContain("tail");
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain("hidden");
  });

  it("fails closed on deeply nested or excessively wide HTML below the input-size cap", () => {
    const deeplyNested = `${"<div>".repeat(5_000)}visible${"</div>".repeat(5_000)}`;
    const excessivelyWide = `<div>${"<span>x</span>".repeat(DEFAULT_HTML_TEXT_LIMITS.maxChildNodes + 1)}</div>`;

    for (const html of [deeplyNested, excessivelyWide]) {
      expect(html.length).toBeLessThan(DEFAULT_HTML_TEXT_LIMITS.maxInputLength);
      try {
        stripHtml(html);
        throw new Error("Expected the HTML structure limit to reject the input.");
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "HTML_STRUCTURE_LIMIT_EXCEEDED", status: 422 });
      }
    }
  });

  it("enforces a caller-supplied HTML input limit", () => {
    expect(() => stripHtml("x".repeat(1_025), {
      ...DEFAULT_HTML_TEXT_LIMITS,
      maxInputLength: 1_024
    })).toThrowError(expect.objectContaining({ code: "HTML_INPUT_LIMIT_EXCEEDED", status: 422 }));
  });
});
