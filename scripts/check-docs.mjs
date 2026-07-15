import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const documentationFiles = ["README.md", ...markdownFilesUnder("docs")];
const failures = [];
const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

for (const relativeFile of documentationFiles) {
  const absoluteFile = path.join(repositoryRoot, relativeFile);
  const markdown = fs.readFileSync(absoluteFile, "utf8");
  const lines = markdown.split(/\r?\n/);

  if (!lines[0]?.startsWith("# ")) failures.push(`${relativeFile}: expected one top-level heading on the first line`);

  let openFence = null;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("```")) continue;
    if (openFence === null) openFence = index + 1;
    else openFence = null;
  }
  if (openFence !== null) failures.push(`${relativeFile}:${openFence}: unclosed fenced code block`);

  for (const match of markdown.matchAll(markdownLinkPattern)) {
    const href = match[1];
    const relativeTarget = href.split("#", 1)[0];
    if (!relativeTarget || /^(?:https?:|mailto:)/.test(relativeTarget)) continue;

    const target = path.resolve(path.dirname(absoluteFile), relativeTarget);
    if (!fs.existsSync(target)) failures.push(`${relativeFile}: broken link -> ${href}`);
  }
}

if (failures.length > 0) {
  console.error(`Documentation validation failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Validated headings, code fences, and relative links across ${documentationFiles.length} documentation files.`);
}

function markdownFilesUnder(relativeDirectory) {
  const files = [];
  const visit = (relativePath) => {
    for (const entry of fs.readdirSync(path.join(repositoryRoot, relativePath), { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
    }
  };
  visit(relativeDirectory);
  return files.sort();
}
