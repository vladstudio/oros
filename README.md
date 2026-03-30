# openrouter-oneshot

Run single prompts with any [OpenRouter](https://openrouter.ai) model. The model gets tools (read/write files, list dirs, run commands, vision) and uses them autonomously in a loop until the task is done.

```
export OPENROUTER_API_KEY=your-key
openrouter-oneshot -m anthropic/claude-sonnet-4 "summarize all .ts files in this directory"
```

## Install

Requires [Bun](https://bun.sh).

```
git clone https://github.com/nicepkg/openrouter-oneshot.git
cd openrouter-oneshot
bun install
bun link
```

## Usage

```
openrouter-oneshot -m MODEL [options] "prompt"
openrouter-oneshot -m MODEL [options] -p prompt.txt
```

Prompt is provided inline as positional args, or read from a text file via `-p`.

**Options:**

- `-m, --model` -- model ID (required), e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4`
- `-p, --prompt-file FILE` -- read prompt from a text file
- `-f, --file FILE` -- attach file(s) to context before running (repeatable; images sent as vision input)
- `-s, --system PROMPT` -- override the default system prompt
- `-u, --use-tools TOOLS` -- comma-separated list of tools to enable (e.g. `read_file,write_file`); use `-u none` to disable all tools
- `-y` -- enable all tools (including `bash`)
- `-v, --verbose` -- show timing, turn info, and tool result sizes on stderr
- `-q, --quiet` -- suppress all output (overrides `-v`)
- `-t, --timeout SECS` -- timeout for API streams and commands (default: 60, 0 = none)
- `-x, --max-turns N` -- max agentic loop iterations (default: 100)
- `--` -- treat all remaining arguments as the prompt

## Built-in tools

The model can call these automatically:

- **read_file** -- read text files; images (png/jpg/webp/gif/bmp/svg) are sent as vision input
- **write_file** -- write content to files (sandboxed to working directory and `/tmp`)
- **list_directory** -- list files and directories
- **file_tree** -- recursive directory tree (respects .gitignore, max depth 5)
- **bash** -- execute shell commands (excluded by default; include via `-u`)

## Examples

```bash
# Attach files (images get vision input)
openrouter-oneshot -m openai/gpt-4o -f screenshot.webp "extract text from this image"

# Prompt from file
openrouter-oneshot -m anthropic/claude-sonnet-4 -p task.txt

# Code task
openrouter-oneshot -m anthropic/claude-sonnet-4 "read src/index.ts and add input validation"

# With shell access
openrouter-oneshot -m google/gemini-2.5-pro -u read_file,bash "find all TODO comments in this project"

# No tools (plain completion, works with any model)
openrouter-oneshot -m meta-llama/llama-3-8b -u none "explain quicksort"

# Debug a stuck run
openrouter-oneshot -v -m openai/gpt-4o -t 120 "your prompt"
```

Output streams to stdout, tool progress and cost/time summary go to stderr.

## License

MIT
