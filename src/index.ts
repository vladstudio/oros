#!/usr/bin/env bun
import OpenAI from "openai";
import { tools as allTools, execute, allowPaths } from "./tools";

const argv = process.argv.slice(2);
let model = "", prompt = "", maxTurns = 100, verbose = false, quiet = false, timeout = 60, historyFile = "", resumeFile = "";
const defaultPrompt = "You are a CLI tool. Execute the user's request directly using the available tools. Never ask for confirmation, never present options. Just do the task.";
const interactivePrompt = "You are a CLI tool. Execute the user's request directly using the available tools. If you need essential information to proceed, use the ask_question tool. Never ask for confirmation, never present options — only ask when you truly cannot proceed without user input.";
let systemPrompt = "";
const files: string[] = [];
const useTools: string[] = [];

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "-m": case "--model": model = argv[++i] ?? ""; break;
    case "-p": case "--prompt-file": {
      const pf = argv[++i] ?? "";
      const f = Bun.file(pf);
      if (!(await f.exists())) { console.error(`Error: prompt file not found: ${pf}`); process.exit(1); }
      prompt = await f.text();
      break;
    }
    case "-f": case "--file": files.push(argv[++i] ?? ""); break;
    case "-s": case "--system": systemPrompt = argv[++i] ?? ""; break;
    case "-u": case "--use-tools": useTools.push(...(argv[++i] ?? "").split(",")); break;
    case "-a": case "--allow": allowPaths(...(argv[++i] ?? "").split(":")); break;
    case "-y": useTools.push(...allTools.map(t => t.function.name)); break;
    case "-o": case "--output-history": historyFile = argv[++i] ?? ""; break;
    case "-r": case "--resume": resumeFile = argv[++i] ?? ""; break;
    case "-v": case "--verbose": verbose = true; break;
    case "-q": case "--quiet": quiet = true; break;
    case "-x": case "--max-turns": { const v = parseInt(argv[++i]); maxTurns = Number.isNaN(v) ? 100 : v; break; }
    case "-t": case "--timeout": { const v = parseInt(argv[++i]); timeout = Number.isNaN(v) ? 60 : v; break; }
    case "-h": case "--help":
      console.log("Usage: oros -m MODEL [options] \"prompt\"");
      console.log("       oros -m MODEL [options] -p prompt.txt");
      console.log("\nPrompt is provided inline as positional args, or from a text file via -p.");
      console.log("\nOptions:");
      console.log("  -m, --model MODEL        Model ID (required)");
      console.log("  -p, --prompt-file FILE   Read prompt from a text file");
      console.log("  -f, --file FILE          Attach file(s) to context (repeatable)");
      console.log("  -s, --system PROMPT      Override system prompt");
      console.log("  -u, --use-tools TOOLS    Comma-separated tools to enable");
      console.log("  -a, --allow PATHS        Extra allowed paths (colon-separated)");
      console.log("  -y                       Enable all tools (including bash)");
      console.log("  -o, --output-history FILE Save conversation history to JSON file");
      console.log("  -r, --resume FILE        Resume from history file (prompt = answer)");
      console.log("  -v, --verbose            Show timing and debug info on stderr");
      console.log("  -q, --quiet              Suppress all output");
      console.log("  -t, --timeout SECS       Timeout for API/commands (default: 60)");
      console.log("  -x, --max-turns N        Max agentic loop iterations (default: 100)");
      console.log("\nTools: " + allTools.map(t => t.function.name).join(", "));
      console.log("  Default: all except bash. Use -y to enable all, -u to pick.");
      process.exit(0);
      break;
    case "--": prompt = argv.slice(i + 1).join(" "); i = argv.length; break;
    default: prompt += (prompt ? " " : "") + argv[i];
  }
}

if (resumeFile) historyFile = resumeFile;
if (!model || !prompt) { console.error("Usage: oros -m MODEL \"prompt\""); process.exit(1); }
if (!process.env.OPENROUTER_API_KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }

if (quiet) verbose = false;
const log = verbose ? (msg: string) => console.error(`[${(performance.now() / 1000).toFixed(1)}s] ${msg}`) : () => { };
const err = quiet ? () => { } : (msg: string) => console.error(msg);
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY });
const optIn = new Set(["bash", "signal_success"]);
const tools = useTools.length ? allTools.filter(t => useTools.includes(t.function.name)) : allTools.filter(t => !optIn.has(t.function.name));
const toolNames = new Set(tools.map(t => t.function.name));
if (!systemPrompt) systemPrompt = toolNames.has("ask_question") ? interactivePrompt : defaultPrompt;
const MAX_CTX_CHARS = 400_000;
function msgSize(msgs: any[]): number {
  let s = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") s += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) if (p.type === "text") s += p.text.length;
    if (m.tool_calls) for (const tc of m.tool_calls) s += (tc.function.arguments?.length ?? 0);
  }
  return s;
}

// build or restore messages
let messages: any[];
if (resumeFile) {
  const f = Bun.file(resumeFile);
  if (!(await f.exists())) { console.error(`Error: resume file not found: ${resumeFile}`); process.exit(1); }
  messages = JSON.parse(await f.text());
  // find the pending ask_question tool_call and append the answer
  const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant" && m.tool_calls);
  const askCall = lastAssistant?.tool_calls?.find((tc: any) => tc.function.name === "ask_question");
  if (!askCall) { console.error("Error: no pending ask_question in history"); process.exit(1); }
  messages.push({ role: "tool", tool_call_id: askCall.id, content: prompt });
  log(`resumed from ${resumeFile}, injected answer`);
} else {
  messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  if (files.length) {
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const id = `preload_${i}`;
      toolCalls.push({ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: f }) } });
      const result = await execute("read_file", { path: f }, timeout);
      if (typeof result === "string" && result.startsWith("Error:")) { console.error(result); process.exit(1); }
      log(`attached: ${f} (${typeof result === "string" ? result.length + " chars" : "image"})`);
      toolResults.push({ role: "tool", tool_call_id: id, content: result as any });
    }
    messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
    messages.push(...toolResults);
  }
}

log(`model=${model} tools=${tools.map(t => t.function.name).join(",")}`);
const startTime = performance.now();
let printed = false, totalCost = 0, consecutiveErrors = 0;

for (let turn = 0; turn < maxTurns; turn++) {
  log(`turn ${turn + 1}/${maxTurns} — sending ${messages.length} messages`);

  let content = "", chunks = 0;
  const tcs = new Map<number, { id: string; name: string; args: string }>();
  for (let retry = 0; ; retry++) {
    content = ""; chunks = 0; tcs.clear();
    const controller = new AbortController();
    let streamTimer = timeout > 0 ? setTimeout(() => controller.abort(), timeout * 1000) : null;
    try {
      const stream = await client.chat.completions.create(
        { model, messages, tools: tools.length ? tools : undefined, stream: true },
        { signal: controller.signal },
      );
      for await (const chunk of stream) {
        if (timeout > 0) { clearTimeout(streamTimer!); streamTimer = setTimeout(() => controller.abort(), timeout * 1000); }
        chunks++;
        const usage = (chunk as any).usage;
        if (usage?.cost != null) totalCost += usage.cost;
        const d = chunk.choices[0]?.delta;
        if (d?.content) { content += d.content; if (!quiet) { process.stdout.write(d.content); printed = true; } }
        for (const tc of d?.tool_calls ?? []) {
          const e = tcs.get(tc.index) ?? { id: `call_${turn}_${tc.index}`, name: "", args: "" };
          if (tc.id) e.id = tc.id;
          if (tc.function?.name) e.name = tc.function.name;
          if (tc.function?.arguments) e.args += tc.function.arguments;
          tcs.set(tc.index, e);
        }
      }
      break;
    } catch (e: any) {
      const status = (e as any).status;
      if (retry < 3 && !content && (status === 429 || (status >= 500 && status < 600))) {
        err(`[retry] HTTP ${status} — waiting ${2 ** retry}s`);
        await Bun.sleep(2 ** retry * 1000);
        continue;
      }
      console.error(`\nAPI error: ${e.message}`);
      process.exit(1);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
    }
  }
  if (verbose && content) process.stderr.write("\n");
  log(`stream done — ${chunks} chunks, ${content.length} chars, ${tcs.size} tool calls`);

  if (!tcs.size) break;

  messages.push({
    role: "assistant", content: content || null,
    tool_calls: [...tcs.values()].map(t => ({
      id: t.id, type: "function" as const, function: { name: t.name, arguments: t.args },
    })),
  });

  const calls = [...tcs.values()].map(tc => {
    let args: any;
    try { args = JSON.parse(tc.args); } catch { args = {}; }
    err(`[tool] ${tc.name}(${JSON.stringify(args)})`);
    return { tc, args };
  });

  // handle ask_question: save history and exit
  const askCall = calls.find(c => c.tc.name === "ask_question");
  if (askCall) {
    if (!quiet) process.stdout.write(`\n${askCall.args.question ?? ""}\n`);
    if (historyFile) await Bun.write(historyFile, JSON.stringify(messages, null, 2));
    process.exit(10);
  }

  // handle signal_success: save history and exit
  if (calls.find(c => c.tc.name === "signal_success")) {
    if (historyFile) await Bun.write(historyFile, JSON.stringify(messages, null, 2));
    process.exit(0);
  }

  const results = await Promise.all(calls.map(({ tc, args }) =>
    toolNames.has(tc.name) ? execute(tc.name, args, timeout) : Promise.resolve(`Error: tool "${tc.name}" not available`)
  ));

  // detect consecutive all-error rounds
  if (results.every(r => typeof r === "string" && r.startsWith("Error:"))) consecutiveErrors++;
  else consecutiveErrors = 0;

  calls.forEach(({ tc }, i) => {
    const r = results[i];
    const isError = typeof r === "string" && r.startsWith("Error:");
    if (isError && !quiet) process.stdout.write(`\n${r}\n`);
    log(`${tc.name} → ${isError ? r : typeof r === "string" ? r.length + " chars" : "image"}`);
    messages.push({ role: "tool", tool_call_id: tc.id, content: r as any });
  });

  // replace old image data with placeholder to avoid resending
  const newToolCount = calls.length;
  for (const msg of messages.slice(0, -newToolCount)) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((p: any) =>
        p.type === "image_url" ? { type: "text", text: "[image already provided]" } : p
      );
    }
  }

  // truncate oldest tool results when context grows too large
  while (msgSize(messages) > MAX_CTX_CHARS) {
    const idx = messages.findIndex((m: any, i: number) => i > 1 && m.role === "tool" && typeof m.content === "string" && m.content.length > 200);
    if (idx === -1) break;
    messages[idx].content = `[truncated — was ${messages[idx].content.length} chars]`;
  }

  // save history after each turn so callers can read progress
  if (historyFile) await Bun.write(historyFile, JSON.stringify(messages, null, 2));

  if (consecutiveErrors >= 3) { err("\n[abort] 3 consecutive failed tool rounds"); break; }
}

if (printed) console.log();
if (historyFile) await Bun.write(historyFile, JSON.stringify(messages, null, 2));
const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
err(`[done] ${elapsed}s${totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}`);
