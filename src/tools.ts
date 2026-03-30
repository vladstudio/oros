import { readdir, stat, realpath } from "fs/promises";
import { join, extname, resolve, dirname, basename } from "path";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};
const CWD = await realpath(process.cwd());
const MAX_OUTPUT = 1_000_000;
const MAX_CMD_TIMEOUT = 300;

async function safePath(p: string): Promise<string> {
  const resolved = resolve(p);
  let real: string;
  try { real = await realpath(resolved); } catch {
    real = join(await realpath(dirname(resolved)), basename(resolved));
  }
  if (real !== CWD && !real.startsWith(CWD + "/") && !real.startsWith("/tmp/") && !real.startsWith("/private/tmp/"))
    throw new Error(`Path not allowed. Allowed: ${CWD} and /tmp. Got: ${real}`);
  return real;
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) return { text: Buffer.concat(chunks).toString("utf-8"), truncated: true };
    chunks.push(Buffer.from(chunk));
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated: false };
}

function def(name: string, desc: string, params: Record<string, any>, required?: string[]) {
  return { type: "function" as const, function: { name, description: desc, parameters: { type: "object" as const, properties: params, required } } };
}

export const tools = [
  def("read_file", "Read a file. Returns image for vision if image file.", { path: { type: "string" } }, ["path"]),
  def("write_file", "Write content to a file.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  def("list_directory", "List files and directories.", { path: { type: "string", description: "defaults to ." } }),
  def("file_tree", "Show recursive directory tree. Dirs first, sorted alphabetically.", { path: { type: "string", description: "defaults to ." } }),
  def("bash", "Run a shell command.", { command: { type: "string" } }, ["command"]),
];

export async function execute(name: string, args: any, timeout = 60): Promise<string | any[]> {
  try {
    if (name === "read_file") {
      const path = await safePath(args.path);
      const file = Bun.file(path);
      const size = file.size;
      const mime = MIME[extname(path).toLowerCase()];
      if (mime) {
        if (size > 10_000_000) return `Error: image too large (${(size / 1024 / 1024).toFixed(1)}MB)`;
        const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
        return [
          { type: "text", text: `Read image: ${args.path}` },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ];
      }
      if (size > 100_000) return `Error: file too large (${(size / 1024).toFixed(0)}KB). Use bash to process it.`;
      const buf = Buffer.from(await file.slice(0, 512).arrayBuffer());
      if (buf.includes(0)) return `Error: binary file (${extname(path)}). Use bash to process it.`;
      return await file.text();
    }
    if (name === "write_file") {
      const path = await safePath(args.path);
      const exists = await Bun.file(path).exists();
      await Bun.write(path, args.content);
      return `Written: ${args.path} (${args.content.length} chars)${exists ? " [overwritten]" : ""}`;
    }
    if (name === "list_directory") {
      const dir = await safePath(args.path || ".");
      const entries = await readdir(dir);
      return (await Promise.all(entries.map(async (e: string) => {
        const s = await stat(join(dir, e));
        return `${s.isDirectory() ? "d" : "f"} ${e}`;
      }))).join("\n");
    }
    if (name === "file_tree") {
      const dir = await safePath(args.path || ".");
      const gitignore = await Bun.file(join(CWD, ".gitignore")).text().catch(() => "");
      const lines = gitignore.split("\n").map(l => l.trim().replace(/\/$/, "")).filter(l => l && !l.startsWith("#"));
      const exact = new Set([".git", ...lines.filter(l => !/[*?[\]]/.test(l))]);
      const globs = lines.filter(l => /[*?[\]]/.test(l)).map(l => new Bun.Glob(l));
      const ignored = (name: string) => exact.has(name) || globs.some(g => g.match(name));
      const MAX_DEPTH = 5, MAX_ENTRIES = 500;
      let count = 0, truncated = false;
      async function buildTree(dirPath: string, prefix: string, depth: number): Promise<string> {
        if (depth >= MAX_DEPTH || truncated) { truncated = true; return ""; }
        let entries: { name: string; isDir: boolean }[];
        try {
          const names = (await readdir(dirPath)).filter(n => !ignored(n));
          entries = (await Promise.all(names.map(async n => {
            const s = await stat(join(dirPath, n));
            return { name: n, isDir: s.isDirectory() };
          }))).sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
        } catch { return ""; }
        let result = "";
        for (let i = 0; i < entries.length; i++) {
          if (++count > MAX_ENTRIES) { truncated = true; break; }
          const { name, isDir } = entries[i];
          const last = i === entries.length - 1;
          result += prefix + (last ? "└─ " : "├─ ") + name + "\n";
          if (isDir) result += await buildTree(join(dirPath, name), prefix + (last ? "   " : "│  "), depth + 1);
        }
        return result;
      }
      const tree = await buildTree(dir, "", 0);
      return basename(dir) + "\n" + tree + (truncated ? `[truncated — max depth ${MAX_DEPTH}, max entries ${MAX_ENTRIES}]\n` : "");
    }
    if (name === "bash") {
      const cmdTimeout = timeout > 0 ? Math.min(timeout, MAX_CMD_TIMEOUT) : MAX_CMD_TIMEOUT;
      const p = Bun.spawn(["sh", "-c", args.command], { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; p.kill(); }, cmdTimeout * 1000);
      const [out, errOut] = await Promise.all([readCapped(p.stdout, MAX_OUTPUT), readCapped(p.stderr, MAX_OUTPUT)]);
      if (out.truncated || errOut.truncated) p.kill();
      await p.exited;
      clearTimeout(timer);
      if (timedOut) return `Error: timed out after ${cmdTimeout}s\n${out.text}`;
      let result = `[exit ${p.exitCode}]\n${out.text}`;
      if (out.truncated) result += `\n[stdout truncated at 1MB]`;
      if (errOut.text) result += `\nstderr:\n${errOut.text}`;
      if (errOut.truncated) result += `\n[stderr truncated at 1MB]`;
      return result;
    }
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    if (e.code === "ENOENT") return `Error: file not found: ${args.path ?? args.command ?? ""}. Use list_directory or file_tree to find correct paths.`;
    return `Error: ${e.message}`;
  }
}
