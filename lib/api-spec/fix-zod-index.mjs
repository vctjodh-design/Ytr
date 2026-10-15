import { readFile, writeFile } from "node:fs/promises";

const indexPath = new URL("../api-zod/src/index.ts", import.meta.url);
const current = await readFile(indexPath, "utf8");
const wildcardExport = /^export \* from ["']\.\/generated\/types["'];?\r?\n?/m;
const cleaned = current.replace(wildcardExport, "");

if (cleaned !== current) {
  await writeFile(indexPath, cleaned);
}
