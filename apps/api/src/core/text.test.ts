import { describe, expect, it } from "vitest";

import { normalizeWhitespace, stripHtml } from "./text.js";

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
});
