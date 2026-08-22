import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readableExtensions = new Set([".ts", ".tsx", ".json", ".md", ".mjs"]);
const ignoredDirectories = new Set([".git", ".next", "node_modules"]);

function readableFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : readableFiles(path.join(directory, entry.name));
    }
    const file = path.join(directory, entry.name);
    return readableExtensions.has(path.extname(file)) || entry.name.startsWith(".env")
      ? [file]
      : [];
  });
}

describe("legacy provider cleanup", () => {
  it("contains no dependency, import, runtime, or documentation references", () => {
    const legacyName = ["va", "pi"].join("");
    const legacyPackage = ["@", legacyName, "-ai/web"].join("");
    const matches = readableFiles(process.cwd()).filter((file) => {
      const contents = fs.readFileSync(file, "utf8").toLowerCase();
      return contents.includes(legacyName) || contents.includes(legacyPackage);
    });

    expect(matches).toEqual([]);
  });
});
