import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const forbidden = [
  ".env",
  "data",
  "node_modules",
  "dist",
  "server.out.log",
  "server.err.log",
];

const forbiddenNamePatterns = [
  /\.log$/i,
  /\.local$/i,
];

function isForbiddenEnvFile(name) {
  return name.toLowerCase().startsWith(".env") && name.toLowerCase() !== ".env.example";
}

async function exists(relativePath) {
  try {
    await fs.stat(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const present = [];
for (const item of forbidden) {
  if (await exists(item)) {
    present.push(item);
  }
}

async function scanDirectory(directory, relativeBase = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relativePath = path.join(relativeBase, entry.name);
    if (isForbiddenEnvFile(entry.name)) {
      present.push(relativePath);
      continue;
    }
    if (forbidden.includes(relativePath.replaceAll("\\", "/"))) {
      present.push(relativePath);
      continue;
    }
    if (forbiddenNamePatterns.some((pattern) => pattern.test(entry.name))) {
      present.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      await scanDirectory(path.join(directory, entry.name), relativePath);
    }
  }
}

await scanDirectory(root);

if (present.length) {
  const unique = Array.from(new Set(present)).sort();
  throw new Error(`Publish-safe audit failed. Remove runtime artifacts first: ${unique.join(", ")}`);
}

console.log("Publish-safe audit passed. No runtime artifacts found.");
