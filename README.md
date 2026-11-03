# Double Shift Search Tabs

Press `Shift` twice and search your whole workspace from one place: files, folders, classes, symbols,
commands and file contents. Tabs narrow the search down, and Match Case, Words, Regex and a file mask
filter every result, the way Search Everywhere works in PyCharm, IntelliJ IDEA and WebStorm.

## Getting started

1. Install the extension.
2. Press `Shift` `Shift`.
3. Type. Results appear as you type; `Enter` opens the selected one.

## Tabs

The first group of icons in the title bar switches what the palette searches. Click one, or press `Tab` /
`Shift+Tab` to move between them. Your query stays and runs again on the new tab.

| Tab | Searches |
|---|---|
| All | Everything below, grouped as Recent, Symbols, Folders, Files, Actions and Text |
| Classes | Classes, interfaces, structs and enums |
| Files | Files and folders |
| Symbols | Every symbol: classes, functions, methods, variables, constants, ... |
| Actions | Commands from VS Code's built-in and installed extensions, e.g. `Git: Commit` |
| Text | File contents, up to 5 matches per file |

Classes and symbols come from your language extensions (Pylance for Python, VS Code's TypeScript support
for JS/TS, and so on), so they only cover files those extensions have indexed.

## Filters

The icons after the divider filter the results. Active filters are highlighted.

| Filter | Effect |
|---|---|
| Match Case | Letter case must match. Command titles ignore it. |
| Words | The query must match a whole word |
| Regex | The query is a regular expression |
| File Mask | Limit results to file names such as `*.py, *.vue`; prefix with `!` to exclude, e.g. `!*.test.ts` |
| Include Non-Project Items | Also search folders that are normally hidden (see [Hidden folders](#hidden-folders)) |

The filters apply to every kind of result: file and folder names, symbols, commands and file contents.
Without Words or Regex, names are matched loosely: several words in any order (`user model`), or the
initials of a CamelCase name (`gua` finds `getUserAccount.ts`).

## Results

- Recently opened files come first, then files staged in Git. Library folders such as `vendor` or
  `site-packages` rank last.
- Symbols and text matches show the file path on a second line. Files and folders use your file icon theme
  (VS Code 1.108 or newer).
- The split button on a result opens it beside the current editor.
- The palette reopens on your last tab with your last filters and query. The query is selected, so typing
  replaces it.

## Hidden folders

Common dependency, build, cache and tool folders, such as `node_modules`, `.venv` and `dist`, are hidden by
default (`doubleShiftSearchTabs.defaultExcludes`). Your `files.exclude` and `search.exclude` settings are
respected too.

To hide more folders, add their names to the `excludeFolders` setting. `*` and `?` work as wildcards, for
example to hide every git worktree of a repository:

```json
{
  "doubleShiftSearchTabs.excludeFolders": ["my-repo-*", "old-clone"]
}
```

## Settings

All settings are under `doubleShiftSearchTabs.`, e.g. `doubleShiftSearchTabs.maxFiles`.

| Setting | Default | Description |
|---|---|---|
| `rememberLastTab` | `true` | Reopen on the last used tab instead of `All` |
| `rememberLastQuery` | `true` | Reopen with the last query, selected |
| `useSelectionAsQuery` | `false` | Start with the text selected in the editor |
| `maxRecentFiles` | `10` | Number of recently opened files to remember |
| `defaultExcludes` | `true` | Hide common dependency, build, cache and tool folders; the full list is in the setting's description |
| `excludeFolders` | `[]` | Extra folder names to hide; `*` and `?` allowed |
| `deprioritizedFolders` | `vendor`, `site-packages`, ... | Folders ranked last instead of hidden |
| `excludeExtensions` | `.zip`, `.png`, `.pdf`, ... | File types skipped by the text search |
| `maxFiles` | `100000` | Maximum number of files to index |

## Known limitations

- VS Code core commands such as Reload Window or Format Document are not listed under Actions: extensions
  cannot read their titles. Use `Cmd+Shift+P` / `Ctrl+Shift+P` for those.
- Group headers show while the query is empty. Once you type, VS Code sorts the results itself and drops
  the headers.
- A language server that is still indexing answers slowly. Files, actions and text matches appear first,
  symbols follow when ready.

## Credits and licence

MIT licence, see [LICENSE](LICENSE).

Based on [Double Shift Search](https://github.com/tristanbudd/vscode-double-shift-search) by Tristan Budd
(MIT). Title bar icons are made from [Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0),
see [media/icons/README.md](media/icons/README.md).
