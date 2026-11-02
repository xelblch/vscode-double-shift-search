# Change Log

## [1.0.0] - Unreleased

First standalone release, based on Double Shift Search 2.0.2 by Tristan Budd: double Shift palette with
fuzzy and CamelHump matching, recent and open editors first, staged-file priority, folder deprioritization,
workspace symbols and file content search.

Added on top:
- Add JetBrains-style search tabs: `All`, `Classes`, `Files`, `Symbols`, `Actions` and `Text`. Tabs are icons in the palette title bar, split from the filter buttons by a divider, and the title shows `Search Everywhere - <tab>`; the active file mask is shown in the placeholder. Click a tab icon or press `Tab` / `Shift+Tab` to switch tabs while keeping the query.
- Add an `Actions` tab that lists commands contributed by VS Code and installed extensions. A few matching actions also appear in `All`.
- The `Text` tab shows up to 5 matches per file instead of only the first.
- Title bar buttons show a pressed look for the current tab and for active filters, using bundled Codicon SVGs (CC BY 4.0).
- Add Match Case, Words and Regex toggles for text search, as title bar buttons and as `⌥⌘C` / `⌥⌘W` / `⌥⌘R` (`Alt+C` / `Alt+W` / `Alt+R` on Windows and Linux). Invalid regular expressions are reported in the list. All three filters also apply to file, folder, symbol and action names (Match Case excepted for actions), so with Match Case on `User` no longer lists `users`. With Regex on, symbols are looked up by the longest plain word in the pattern and then checked against the full expression.
- Add a file mask filter (e.g. `*.py, *.vue, !*.test.ts`) for file and text results.
- Add an "Include Non-Project Items" toggle that ignores `files.exclude`, `search.exclude` and `searchEverywhereTabs.excludeFolders` (only `.git` is skipped).
- Hide common dependency, build, cache and tool folders by default (`searchEverywhereTabs.defaultExcludes`); `searchEverywhereTabs.excludeFolders` adds to that list and accepts `*` / `?` wildcards.
- Add an "Open In Right Split" button to file, symbol and text results.
- Results are grouped under `Recent`, `Symbols`, `Folders`, `Files`, `Actions` and `Text` headers, symbols and text matches show their file path on a second line, and files and folders use file icon theme icons (VS Code 1.108+) instead of `$(...)` label prefixes.
- The palette remembers the last tab and filters. Add a new `searchEverywhereTabs.rememberLastTab` setting (default `true`) to always start on `All` instead.
- The palette reopens with the last query pre-selected, so typing replaces it. Turn off with `searchEverywhereTabs.rememberLastQuery`.
