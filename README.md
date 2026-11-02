# Search Everywhere Tabs

JetBrains-style **Search Everywhere** for VS Code. Press `Shift` twice to open one palette for files, folders,
symbols, actions and text, with tabs and filters like the PyCharm / IntelliJ version.

## Features

- **Double Shift Trigger**: Hit `Shift` twice rapidly to open the Search Everywhere palette.
- **Unified Custom Palette**: An interface that replicates the JetBrains Search Everywhere experience, natively integrated into VS Code.
- **Deep Content Search**: Searches file contents instantly, skipping heavy assets (archives, media, binaries) for maximum speed.
- **Workspace Symbols**: Queries workspace symbols to jump straight to classes, methods, and functions.
- **Smart Multi-Term Fuzzy Matching**: Type multiple words (e.g., `folder config`) to match across your entire workspace.
- **CamelHump/Acronym Matching**: Type initials like `gua` to jump to `getUserAccount.ts`. Matches are ranked by quality.
- **Open Editors First**: Prioritizes currently open files at the top of the list.
- **Staged File Priority**: Files staged in Git are ranked ahead of everything else.
- **Vendor/Library Deprioritization**: Folders like `vendor`, `Pods`, and `node_modules` are ranked lower automatically.
- **Search Tabs**: `All`, `Classes`, `Files`, `Symbols`, `Actions` and `Text`, shown as icons in the palette title bar, split from the filter buttons by a divider; the title reads `Search Everywhere - <tab>`. Click a tab icon, or press `Tab` / `Shift+Tab`, to switch tabs; the typed query is kept and re-run.
- **Actions**: Run any command contributed by VS Code or an installed extension (e.g. `Git: Commit`). A few matching actions also appear near the bottom of the `All` tab.
- **Text Filters**: Match Case, Words and Regex buttons in the palette title bar, also toggled with `⌥⌘C` / `⌥⌘W` / `⌥⌘R` on macOS (`Alt+C` / `Alt+W` / `Alt+R` on Windows and Linux). They apply to the `Text` tab and the text matches in `All`. All three filters also apply to file, folder, symbol and action names (Match Case excepted for actions), so with Match Case on `User` no longer lists `users`. With Regex on, symbols are looked up by the longest plain word in the pattern and then checked against the full expression. An invalid regular expression is shown as a warning instead of results.
- **File Mask**: The filter button asks for a comma-separated mask such as `*.py, *.vue, !*.test.ts` and applies it to file and text results. Prefix a pattern with `!` to exclude it.
- **Include Non-Project Items**: The eye button includes files hidden by `files.exclude`, `search.exclude` and `searchEverywhereTabs.excludeFolders` (only `.git` is still skipped), capped by `searchEverywhereTabs.maxFiles`.
- **Grouped, Readable Results**: Results are grouped under headers such as `Recent`, `Folders` and `Files` (VS Code hides the headers while it sorts a typed query). Symbols and text matches put the file path on a second line, and files and folders use your file icon theme (VS Code 1.108+; older versions show generic file and folder icons).
- **Open In Right Split**: Hover a file, symbol or text result and click the split button to open it beside the current editor.
- **Remembered State**: The palette reopens on the last tab with the last filters and the last query, pre-selected so typing replaces it.

### Configuration

You can customize the behavior of Search Everywhere Tabs in your VS Code settings:
- `searchEverywhereTabs.useSelectionAsQuery` (Default: `false`): Automatically pre-fills the search palette with the text you currently have selected in your active editor.
- `searchEverywhereTabs.rememberLastTab` (Default: `true`): Reopens the palette on the last used tab. When disabled, the palette always opens on `All`. Filters are remembered either way.
- `searchEverywhereTabs.rememberLastQuery` (Default: `true`): Reopens the palette with the last query already selected, so typing replaces it and `Enter` or the arrow keys reuse it. The search runs again, so results are current.
- `searchEverywhereTabs.excludeExtensions` (Default: `['.zip', '.tar', '.png', ...] `): A list of file extensions to completely ignore when searching file contents.
- `searchEverywhereTabs.deprioritizedFolders` (Default: `['vendor', 'Pods', 'site-packages', ...]`): A list of folder names to rank lower in search results, without hiding them entirely.
- `searchEverywhereTabs.defaultExcludes` (Default: `true`): Hides common dependency, build, cache and tool folders (`node_modules`, `.venv`, `venv`, `dist`, `build`, `out`, `.next`, `.nuxt`, `coverage`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.cache`, `.git`, `.idea`, ...). `excludeFolders` adds to it instead of replacing it.
- `searchEverywhereTabs.excludeFolders` (Default: `[]`): Folder names to exclude from search entirely, on top of `files.exclude`, `search.exclude` and the built-in list. Names may use `*` and `?`, e.g. `gtaapi-tec-*` to hide git worktree copies.
- `searchEverywhereTabs.maxFiles` (Default: `100000`): The maximum number of files to index. Acts as a safety cap for very large workspaces.

## Installation

The extension isn't published to the Marketplace. Build and install it locally:

```bash
npm install
npx @vscode/vsce package
code --install-extension search-everywhere-tabs-1.0.0.vsix
```

Run **Developer: Reload Window** afterwards.

## Development

```bash
npm install          # Install dependencies
npm run compile      # Type-check and bundle to dist/
npm run watch        # Rebuild on changes
npm run lint         # ESLint
npm test             # Extension test suite (downloads VS Code on first run)
```

Press `F5` in VS Code to launch an Extension Development Host.

## Credits & Licence

Licensed under the **[MIT Licence](LICENSE)**.

Started from [Double Shift Search](https://github.com/tristanbudd/vscode-double-shift-search) by Tristan Budd (MIT).
Title bar icons are generated from [Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0), see
[media/icons/README.md](media/icons/README.md).
