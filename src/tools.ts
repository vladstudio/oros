import { readdir, stat, lstat, realpath } from "fs/promises";
import { join, extname, resolve, dirname, basename } from "path";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};
const CWD = await realpath(process.cwd());
const EXTRA_PATHS = (process.env.OROS_ALLOWED_PATHS || "").split(":").filter(Boolean).map(p => resolve(p));

export function allowPaths(...paths: string[]) {
  EXTRA_PATHS.push(...paths.map(p => resolve(p)));
}
const MAX_OUTPUT = 1_000_000;
const MAX_CMD_TIMEOUT = 300;

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', laquo: '\u00AB', raquo: '\u00BB',
  };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec, hex, name) =>
    dec ? String.fromCharCode(+dec) : hex ? String.fromCharCode(parseInt(hex, 16)) : map[name?.toLowerCase()] ?? m
  );
}

function htmlToMd(html: string): string {
  let s = html;
  // Remove junk elements
  s = s.replace(/<(script|style|head|nav|footer|header|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Code blocks → placeholders
  const cb: string[] = [];
  s = s.replace(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, attrs, code) => {
    const lang = attrs.match(/\bclass="[^"]*\blanguage-(\w+)/i)?.[1] || '';
    cb.push(`\n\`\`\`${lang}\n${decodeEntities(code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n`);
    return `\x00${cb.length - 1}\x00`;
  });
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    cb.push(`\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n`);
    return `\x00${cb.length - 1}\x00`;
  });
  // Inline elements (before block processing so nesting works)
  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '_$1_');
  s = s.replace(/<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, '~~$1~~');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c.replace(/<[^>]+>/g, '')}\``);
  s = s.replace(/<img\b([^>]*?)\/?>/gi, (_, a) => {
    const src = a.match(/\bsrc=["']?([^"'\s>]+)/i)?.[1] || '';
    return src ? `![${(a.match(/\balt=["']([^"']*)/i)?.[1]) || ''}](${src})` : '';
  });
  s = s.replace(/<a\b[^>]*\bhref=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) =>
    `[${t.replace(/<[^>]+>/g, '').trim()}](${h})`);
  // Block elements
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) =>
    `\n\n${'#'.repeat(+l)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, tbl) => {
    const rows = [...tbl.replace(/<\/?(thead|tbody|tfoot|caption)\b[^>]*>/gi, '')
      .matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(r => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()))
      .filter(r => r.length);
    if (!rows.length) return '';
    const cols = Math.max(...rows.map(r => r.length));
    let o = '\n\n';
    rows.forEach((r, i) => {
      const p = Array.from({ length: cols }, (_, j) => r[j] ?? '');
      o += '| ' + p.join(' | ') + ' |\n';
      if (i === 0) o += '|' + p.map(() => ' --- ').join('|') + '|\n';
    });
    return o + '\n';
  });
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) =>
    '\n' + t.replace(/<[^>]+>/g, '').trim().split(/\n/).map((l: string) => `> ${l.trim()}`).join('\n') + '\n');
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, c) => {
    let n = 0; return '\n' + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_: string, t: string) =>
      `\n${++n}. ${t.replace(/<[^>]+>/g, '').trim()}`).replace(/<[^>]+>/g, '') + '\n';
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, c) =>
    '\n' + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_: string, t: string) =>
      `\n* ${t.replace(/<[^>]+>/g, '').trim()}`).replace(/<[^>]+>/g, '') + '\n');
  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|section|article|aside|main|figure|figcaption|dd|dt)\s*>/gi, '\n\n');
  s = s.replace(/<(?:p|div|section|article|aside|main|figure|figcaption|dd|dt)\b[^>]*>/gi, '\n\n');
  // Cleanup
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => cb[+i]);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/^ +| +$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function safePath(p: string): Promise<string> {
  const resolved = resolve(p);
  let real: string;
  try { real = await realpath(resolved); } catch {
    real = join(await realpath(dirname(resolved)), basename(resolved));
  }
  const allowed = real === CWD || real.startsWith(CWD + "/") || real.startsWith("/tmp/") || real.startsWith("/private/tmp/")
    || EXTRA_PATHS.some(p => real === p || real.startsWith(p + "/"));
  if (!allowed)
    throw new Error(`Path not allowed. Allowed: ${CWD}, /tmp${EXTRA_PATHS.length ? ", " + EXTRA_PATHS.join(", ") : ""}. Got: ${real}`);
  if (real.startsWith("/tmp/") || real.startsWith("/private/tmp/")) {
    try { if ((await lstat(resolved)).isSymbolicLink()) throw new Error(`Symlinks not allowed in /tmp: ${p}`); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
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
  def("edit_file", "Apply surgical text replacements to a file. More efficient than write_file for edits.", {
    path: { type: "string" },
    edits: { type: "array", items: { type: "object", properties: { old: { type: "string", description: "Exact text to find (must match exactly once)" }, new: { type: "string", description: "Replacement text" } }, required: ["old", "new"] }, description: "Edits applied sequentially." },
  }, ["path", "edits"]),
  def("list_directory", "List files and directories.", { path: { type: "string", description: "defaults to ." } }),
  def("file_tree", "Show recursive directory tree. Dirs first, sorted alphabetically.", { path: { type: "string", description: "defaults to ." } }),
  def("bash", "Run a shell command.", { command: { type: "string" } }, ["command"]),
  def("web_html", "Fetch a URL and return raw HTML.", { url: { type: "string" } }, ["url"]),
  def("web_md", "Fetch a URL and return content as clean Markdown.", { url: { type: "string" } }, ["url"]),
  def("web_search", "Search the web via DuckDuckGo. Returns results as Markdown.", { query: { type: "string" } }, ["query"]),
  def("ask_question", "Ask the user a question and wait for their response. Use when you need clarification or a decision to proceed.", { question: { type: "string" } }, ["question"]),
  def("signal_success", "Signal that the task completed successfully. Call this as the very last action.", {}),
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
    if (name === "edit_file") {
      const path = await safePath(args.path);
      let text = await Bun.file(path).text();
      const lines: number[] = [];
      for (const edit of args.edits) {
        const idx = text.indexOf(edit.old);
        if (idx === -1) return `Error: no match for edit in ${args.path}:\n${edit.old.slice(0, 200)}`;
        if (text.indexOf(edit.old, idx + 1) !== -1) return `Error: multiple matches (${text.split(edit.old).length - 1}) for edit in ${args.path}. Provide more context to make it unique.`;
        lines.push(text.slice(0, idx).split("\n").length);
        text = text.slice(0, idx) + edit.new + text.slice(idx + edit.old.length);
      }
      await Bun.write(path, text);
      return `Edited: ${args.path} (${args.edits.length} edit${args.edits.length > 1 ? "s" : ""}, line${lines.length > 1 ? "s" : ""} ${lines.join(", ")})`;
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
    if (name === "web_html" || name === "web_md") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout * 1000);
      try {
        const resp = await fetch(args.url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; oros/0.1)" }, redirect: "follow" });
        if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
        const html = await resp.text();
        const out = name === "web_md" ? htmlToMd(html) : html;
        return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + `\n[truncated at ${MAX_OUTPUT} chars]` : out;
      } catch (e: any) {
        return `Error: ${e.message}`;
      } finally { clearTimeout(timer); }
    }
    if (name === "web_search") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout * 1000);
      try {
        const resp = await fetch("https://html.duckduckgo.com/html/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `q=${encodeURIComponent(args.query)}`,
          signal: controller.signal,
        });
        const html = await resp.text();
        const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
        const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
        if (!links.length) return "No results found.";
        let md = '';
        for (let i = 0; i < links.length && i < 10; i++) {
          const title = decodeEntities(links[i][2].replace(/<[^>]+>/g, '').trim());
          let url = links[i][1];
          try { url = decodeURIComponent(new URL(url, "https://duckduckgo.com").searchParams.get("uddg") || url); } catch { }
          const snippet = snippets[i] ? decodeEntities(snippets[i][1].replace(/<[^>]+>/g, '').trim()) : '';
          md += `${i + 1}. [${title}](${url})\n`;
          if (snippet) md += `   ${snippet}\n`;
          md += '\n';
        }
        return md;
      } catch (e: any) {
        return `Error: ${e.message}`;
      } finally { clearTimeout(timer); }
    }
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    if (e.code === "ENOENT") return `Error: file not found: ${args.path ?? args.command ?? ""}. Use list_directory or file_tree to find correct paths.`;
    return `Error: ${e.message}`;
  }
}
