import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const compileMql5: PromptModule = definePrompt(
	buildCompileMql5Prompt(),
	buildCompileMql5Prompt,
);

function buildCompileMql5Prompt(): string {
	return `Compile a .mq5 file with the official MetaTrader 5 compiler (MetaEditor64.exe) installed by the user. On Linux and macOS the compiler runs through Wine; no GUI is opened.

Call this after creating or editing an MQL5 source file, before reporting the work as finished. Pass \`file_path\` (absolute or relative to the session working directory). The optional \`timeout\` is in seconds.

The result is JSON with \`success\`, \`file\`, \`output\`, \`errors\`, \`warnings\`, \`message\` and \`log_path\`. Errors and warnings carry real MetaEditor line and column numbers. \`success\` is true only when the compiler log reports 0 errors and a new .ex5 was actually written by this run; a fresh-looking file from an earlier build is not accepted.

When \`success\` is false because of compiler errors:
1. Read every reported error and its line.
2. Fix the source file with Edit/Write.
3. Call CompileMql5 again for the same file.
Repeat until it succeeds or the remaining problems need a user decision. Do not report success while errors remain, and do not loop after the same unfixable error repeats.

Warnings do not block success; fix meaningful ones and mention the rest.

If the tool reports that MetaEditor is unavailable, tell the user what is missing (MetaTrader 5 with MetaEditor, Wine on Linux/macOS, or the \`mql5.metaeditorPath\` / \`mql5.winePath\` settings). Do not install, download or embed MetaQuotes binaries, and do not try to compile by calling MetaEditor through Execute.`;
}
