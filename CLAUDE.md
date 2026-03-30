# CLAUDE.md

## Project

Single-file-ish CLI that runs one-shot agentic prompts via OpenRouter. Bun + TypeScript, no build step.

## Structure

- `src/index.ts` -- entry point: arg parsing, streaming agentic loop
- `src/tools.ts` -- tool definitions (OpenAI function calling format) and execution

## Conventions

- Bun runtime, not Node. Use Bun APIs (`Bun.file`, `Bun.write`, `Bun.spawn`).
- No build step. `src/index.ts` runs directly via `bun`.
- Keep it minimal. Two source files. Avoid new dependencies unless absolutely necessary.
- Tool output to stdout, diagnostics/progress to stderr.
- All file tools are sandboxed to cwd and `/tmp` via `safePath()`.
- `bash` tool is excluded by default; enable it via `-u` (e.g. `-u read_file,bash`).
- Web tools (`web_html`, `web_md`, `web_search`) use native `fetch()`. HTML→Markdown conversion is a zero-dep regex-based `htmlToMd()` function in tools.ts.

## Running

```
bun install
bun src/index.ts -m MODEL "prompt"
```

## Testing

No test framework. Test manually:
```
bun src/index.ts --help
bun src/index.ts -m openai/gpt-4o-mini "list files in current directory"
```
