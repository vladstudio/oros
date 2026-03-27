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
- All file tools are sandboxed to cwd via `safePath()`.
- `--allow-commands` gates shell access; without it, `run_command` is hidden from the model entirely.

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
