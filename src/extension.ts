import * as vscode from 'vscode';
import * as path from 'path';

import * as fs from 'fs/promises';

export interface SearchItem extends vscode.QuickPickItem {
  type: 'editor' | 'file' | 'directory' | 'symbol' | 'action' | 'text' | 'command' | 'separator';
  uri?: vscode.Uri;
  // With iconPath ThemeIcon.File/Folder this shows the file icon theme icon; VS Code before 1.108 ignores it.
  resourceUri?: vscode.Uri;
  // Workspace-relative path of a file or folder item, scored together with its label.
  relativePath?: string;
  symbol?: vscode.SymbolInformation;
  action?: 'findInFiles' | 'commands';
  lineNumber?: number;
  commandId?: string;
}

let cachedFilesPromise: Thenable<vscode.Uri[]> | undefined;
let cachedDirsPromise: Thenable<vscode.Uri[]> | undefined;
let cachedNonProjectFilesPromise: Thenable<vscode.Uri[]> | undefined;
let cachedNonProjectDirsPromise: Thenable<vscode.Uri[]> | undefined;
let cachedCommands: ContributedCommand[] | undefined;
let activeSearchCts: vscode.CancellationTokenSource | undefined;
let activePalette: PaletteController | undefined;

export type SearchTab = 'all' | 'classes' | 'files' | 'symbols' | 'actions' | 'text';
type ToggleKey = 'matchCase' | 'wholeWord' | 'regex' | 'includeNonProject';

export interface TextSearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface PaletteState extends TextSearchOptions {
  tab: SearchTab;
  fileMask: string;
  includeNonProject: boolean;
}

interface PaletteController {
  setTab(tab: SearchTab): void;
  cycleTab(direction: 1 | -1): void;
  toggle(key: ToggleKey): void;
}

interface PaletteButton extends vscode.QuickInputButton {
  action: ToggleKey | 'fileMask' | 'tab' | 'divider';
  tab?: SearchTab;
}

export const SEARCH_TABS: readonly SearchTab[] = ['all', 'classes', 'files', 'symbols', 'actions', 'text'];

const TAB_LABELS: Record<SearchTab, string> = {
  all: 'All', classes: 'Classes', files: 'Files', symbols: 'Symbols', actions: 'Actions', text: 'Text'
};

const TAB_ICONS: Record<SearchTab, string> = {
  all: 'search', classes: 'symbol-class', files: 'file', symbols: 'symbol-method', actions: 'symbol-event', text: 'file-text'
};

const TAB_PLACEHOLDERS: Record<SearchTab, string> = {
  all: 'Search Everywhere (Files, Symbols, Actions, Text)',
  classes: 'Search classes, interfaces, structs and enums',
  files: 'Search files and folders',
  symbols: 'Search workspace symbols',
  actions: 'Search actions and commands',
  text: 'Search file contents'
};

export const DEFAULT_PALETTE_STATE: PaletteState = {
  tab: 'all', matchCase: false, wholeWord: false, regex: false, fileMask: '', includeNonProject: false
};

// VS Code centres the quick input title (text-align: center). A line wider than the title box
// overflows from its start instead, so trailing no-break spaces pin the text to the left. Spaces
// and hyphens inside the text become no-break characters too, or the title wraps onto two lines.
const TITLE_LEFT_ALIGN_PADDING = '\u00a0'.repeat(400);

export function toUnbreakableTitle(text: string): string {
  return text.replace(/ /g, '\u00a0').replace(/-/g, '\u2011') + TITLE_LEFT_ALIGN_PADDING;
}
const PALETTE_STATE_KEY = 'doubleShiftSearchTabs.paletteState';
const LAST_QUERY_KEY = 'doubleShiftSearchTabs.lastQuery';
const PALETTE_VISIBLE_CONTEXT = 'doubleShiftSearchTabs.paletteVisible';
const SEARCH_DEBOUNCE_MS = 300;
const ALL_TAB_MAX_ACTIONS = 5;
const ACTIONS_TAB_MAX_RESULTS = 100;
const SYMBOLS_TAB_MAX_RESULTS = 200;
const TEXT_TAB_MAX_RESULTS = 200;
const TEXT_TAB_MAX_MATCHES_PER_FILE = 5;

const CLASS_SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum
]);

const OPEN_TO_SIDE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('split-horizontal'),
  tooltip: 'Open In Right Split'
};

// Hidden on top of files.exclude / search.exclude unless doubleShiftSearchTabs.defaultExcludes is off.
// The "Include Non-Project Items" toggle still shows them.
export const DEFAULT_EXCLUDED_FOLDERS = [
  'node_modules', '.venv', 'venv', 'bower_components',
  'dist', 'build', 'out', '.next', '.nuxt', '.output', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.cache', '.gradle',
  '.git', '.idea', '.vscode-test', '.omc', '.playwright-mcp'
];

const DEFAULT_DEPRIORITIZED_FOLDERS = [
  'vendor', 'vendors', 'bower_components', 'third_party', 'third-party',
  'packages', 'Pods', 'venv', '.venv', 'site-packages', '__pycache__',
  'target', '.gradle', 'Carthage', 'DerivedData', '.tox', '.mypy_cache',
  '.pytest_cache', '.next', '.nuxt', 'coverage', '.cache'
];

interface GitRepositoryState {
  indexChanges: { uri: vscode.Uri }[];
}
interface GitRepository {
  state: GitRepositoryState;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

const DEFAULT_MAX_FILES = 100000;
const REFRESH_DEBOUNCE_MS = 1000;
const GLOB_SPECIAL_CHARS = /[*?[\]{}]/;

let refreshTimer: NodeJS.Timeout | undefined;
let hasWarnedAboutFileCap = false;

export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    return [pattern];
  }
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) {
      commas.push(i);
    }
  }
  if (close === -1) {
    return [pattern];
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const results: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const option = pattern.slice(bounds[i] + 1, bounds[i + 1]);
    results.push(...expandBraces(prefix + option + suffix));
  }
  return results;
}

export function getExcludePatterns(scope?: vscode.Uri): string[] {
  const patterns = new Set<string>();
  for (const section of ['files.exclude', 'search.exclude']) {
    const map = vscode.workspace.getConfiguration(undefined, scope).get<Record<string, unknown>>(section) || {};
    for (const [glob, enabled] of Object.entries(map)) {
      if (enabled === true) {
        expandBraces(glob).forEach(p => patterns.add(p));
      }
    }
  }
  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs', scope);
  const excludeFolders = [
    ...(config.get<boolean>('defaultExcludes', true) ? DEFAULT_EXCLUDED_FOLDERS : []),
    ...(config.get<string[]>('excludeFolders') || [])
  ];
  for (const folder of excludeFolders) {
    const name = folder.trim().replace(/^[\\/]+|[\\/]+$/g, '').replace(/\\/g, '/');
    if (name) {
      patterns.add(`**/${name}`);
    }
  }
  return Array.from(patterns);
}

export function buildExcludeGlob(patterns: string[]): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

export function getExcludedFolderNames(patterns: string[]): Set<string> {
  const names = new Set<string>(['.git']);
  for (const pattern of patterns) {
    const match = /^\*\*\/([^/]+?)(\/\*\*)?$/.exec(pattern);
    if (match && !GLOB_SPECIAL_CHARS.test(match[1])) {
      names.add(match[1].toLowerCase());
    }
  }
  return names;
}

// True when a path sits inside an excluded folder (by name or folder-name glob). Used for watcher
// events and for workspace symbols, which language servers return from the whole workspace.
function isExcludedPath(fsPath: string): boolean {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  const patterns = getExcludePatterns(workspaceFolder?.uri);
  const ignored = getExcludedFolderNames(patterns);
  // Folder-name globs such as "**/gtaapi-tec-*" are matched against each path segment.
  const ignoredGlobs = patterns
    .map(pattern => /^\*\*\/([^/]+?)(\/\*\*)?$/.exec(pattern)?.[1])
    .filter((name): name is string => !!name && GLOB_SPECIAL_CHARS.test(name) && !/[[\]{}]/.test(name))
    .map(globToRegExp);
  return fsPath.split(/[\\/]/).some(seg => ignored.has(seg.toLowerCase()) || ignoredGlobs.some(glob => glob.test(seg)));
}

export async function getStagedFileUris(): Promise<Set<string>> {
  const staged = new Set<string>();
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      return staged;
    }
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const gitApi = exports.getAPI(1);
    for (const repo of gitApi.repositories) {
      for (const change of repo.state.indexChanges) {
        staged.add(change.uri.toString());
      }
    }
  } catch (e) {
    // The built-in git extension may be disabled or unavailable; treat as no staged files.
  }
  return staged;
}

export function getDeprioritizedFolderSet(): Set<string> {
  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
  const folders = config.get<string[]>('deprioritizedFolders') || DEFAULT_DEPRIORITIZED_FOLDERS;
  return new Set(folders.map(f => f.toLowerCase()));
}

export function isInDeprioritizedFolder(fsPath: string, deprioritizedFolders: Set<string>): boolean {
  if (deprioritizedFolders.size === 0) {
    return false;
  }
  const segments = fsPath.split(/[\\/]/);
  return segments.some(seg => deprioritizedFolders.has(seg.toLowerCase()));
}

const HUMP_SEPARATORS = new Set(['-', '_', '.', '/', '\\']);

function isAsciiDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isAsciiLower(c: string): boolean { return c >= 'a' && c <= 'z'; }
function isAsciiUpper(c: string): boolean { return c >= 'A' && c <= 'Z'; }

// Hump starts: index 0, the char after a separator, a digit->letter transition, or a
// lower->upper transition. ASCII-only; does not special-case consecutive-uppercase runs
// (e.g. "IOError").
function getHumpIndices(text: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (i === 0) { indices.push(i); continue; }
    const prev = text[i - 1];
    const curr = text[i];
    if (HUMP_SEPARATORS.has(prev)) {
      indices.push(i);
    } else if (isAsciiDigit(prev) && (isAsciiLower(curr) || isAsciiUpper(curr))) {
      indices.push(i);
    } else if (isAsciiLower(prev) && isAsciiUpper(curr)) {
      indices.push(i);
    }
  }
  return indices;
}

const SUBSTRING_BASE = 1000;
const SUBSTRING_START_BONUS = 500;
const SUBSTRING_HUMP_BONUS = 250;
const SUBSTRING_PROXIMITY_CAP = 50;
const ACRONYM_BASE = 200;
const ACRONYM_FIRST_HUMP_BONUS = 100;
const ACRONYM_COMPACTNESS_CAP = 50;
const ACRONYM_SKIP_PENALTY_PER_HUMP = 10;
const LENGTH_TIEBREAK_WEIGHT = 0.1;

// With matchCase the comparisons below run on the original text, so "User" no longer matches "user".
function scoreSingleTerm(term: string, text: string, matchCase: boolean): number | null {
  const fold = (value: string) => matchCase ? value : value.toLowerCase();
  const lowerTerm = fold(term);
  const lowerText = fold(text);

  // Tier 1: exact substring.
  const idx = lowerText.indexOf(lowerTerm);
  if (idx !== -1) {
    let score = SUBSTRING_BASE;
    if (idx === 0) {
      score += SUBSTRING_START_BONUS;
    } else if (getHumpIndices(text).includes(idx)) {
      score += SUBSTRING_HUMP_BONUS;
    }
    score += Math.max(0, SUBSTRING_PROXIMITY_CAP - idx);
    return score - text.length * LENGTH_TIEBREAK_WEIGHT;
  }

  // Tier 2: strict hump/acronym match - pattern chars must land on hump-boundary
  // characters of text, in order (not a free subsequence over the whole string).
  const humpIndices = getHumpIndices(text);
  if (humpIndices.length < lowerTerm.length) {
    return null;
  }

  let ptr = 0;
  let firstMatchRank = -1;
  for (let p = 0; p < lowerTerm.length; p++) {
    const ch = lowerTerm[p];
    let found = false;
    while (ptr < humpIndices.length) {
      const textCh = fold(text[humpIndices[ptr]]);
      ptr++;
      if (textCh === ch) {
        if (firstMatchRank === -1) { firstMatchRank = ptr - 1; }
        found = true;
        break;
      }
    }
    if (!found) {
      return null;
    }
  }

  let score = ACRONYM_BASE;
  if (firstMatchRank === 0) { score += ACRONYM_FIRST_HUMP_BONUS; }
  const skipped = ptr - lowerTerm.length;
  score += Math.max(0, ACRONYM_COMPACTNESS_CAP - skipped * ACRONYM_SKIP_PENALTY_PER_HUMP);
  return score - text.length * LENGTH_TIEBREAK_WEIGHT;
}

// Multi-term AND-semantics (all terms must match) combined via sum: every candidate being
// compared already passed the AND filter, so summing rewards items where every term matches
// strongly instead of a min() dragging a great match down to its weakest term's score.
export function fuzzyScore(pattern: string, text: string, matchCase = false): number | null {
  const terms = pattern.split(' ').filter(t => t.length > 0);
  if (terms.length === 0) {
    return 0;
  }
  let total = 0;
  for (const term of terms) {
    const s = scoreSingleTerm(term, text, matchCase);
    if (s === null) {
      return null;
    }
    total += s;
  }
  return total;
}

export function fuzzyMatch(pattern: string, text: string, matchCase = false): boolean {
  return fuzzyScore(pattern, text, matchCase) !== null;
}

function scoreSearchItem(item: SearchItem, match: NameMatcher): number | null {
  const labelScore = match(item.label);
  const descScore = match(item.relativePath || '');
  if (labelScore === null && descScore === null) {
    return null;
  }
  if (labelScore === null) { return descScore as number; }
  if (descScore === null) { return labelScore; }
  return Math.max(labelScore, descScore);
}

// Filters + scores in one pass, then sorts by (primaryRank asc, score desc). primaryRank
// must reproduce whatever bucket order the source array already has (staged/deprioritized),
// so this is a secondary key WITHIN existing buckets - it never reorders across them.
function filterAndScoreItems(
  items: SearchItem[],
  match: NameMatcher,
  getPrimaryRank: (item: SearchItem) => number
): SearchItem[] {
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const score = scoreSearchItem(item, match);
    if (score !== null) {
      scored.push({ item, score });
    }
  }
  scored.sort((a, b) => {
    const rankDiff = getPrimaryRank(a.item) - getPrimaryRank(b.item);
    return rankDiff !== 0 ? rankDiff : b.score - a.score;
  });
  return scored.map(s => s.item);
}

export function cycleTab(tab: SearchTab, direction: 1 | -1): SearchTab {
  const index = SEARCH_TABS.indexOf(tab);
  return SEARCH_TABS[(index + direction + SEARCH_TABS.length) % SEARCH_TABS.length];
}

export type TextSearchRegexResult = { regex: RegExp } | { error: string };

// Always global (searchFileContents walks matches via lastIndex) and multiline so ^/$ anchor
// to lines in regex mode. Whole word uses lookarounds rather than \b so queries that start or
// end with a non-word character (e.g. "$scope", "->") still match.
export function buildTextSearchRegex(query: string, options: TextSearchOptions): TextSearchRegexResult {
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) {
    source = `(?<!\\w)(?:${source})(?!\\w)`;
  }
  try {
    return { regex: new RegExp(source, options.matchCase ? 'gm' : 'gim') };
  } catch (e) {
    // V8 messages repeat the whole pattern ("Invalid regular expression: /(/gm: Unterminated group");
    // the row label already says it is invalid, so keep only the reason.
    const message = e instanceof Error ? e.message : String(e);
    return { error: message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '') };
  }
}

// Scores a file, folder, symbol or command name against the query, or returns null when it does not
// match. Plain queries use fuzzy/CamelHump matching; Words and Regex switch to the same regular
// expression the text search uses, so all three filters behave alike for names and file contents.
export type NameMatcher = (text: string) => number | null;

export function createNameMatcher(query: string, options: TextSearchOptions): NameMatcher | { error: string } {
  if (!query.trim()) {
    return () => 0;
  }
  if (!options.regex && !options.wholeWord) {
    return text => fuzzyScore(query, text, options.matchCase);
  }
  const built = buildTextSearchRegex(query, options);
  if ('error' in built) {
    return built;
  }
  // Drop the global flag: a shared global RegExp would carry lastIndex from one name to the next.
  const regex = new RegExp(built.regex.source, built.regex.flags.replace('g', ''));
  return text => {
    const match = regex.exec(text);
    if (!match) {
      return null;
    }
    const start = match.index === 0 ? SUBSTRING_START_BONUS : 0;
    return SUBSTRING_BASE + start + Math.max(0, SUBSTRING_PROXIMITY_CAP - match.index) - text.length * LENGTH_TIEBREAK_WEIGHT;
  };
}

export interface FileMask {
  include: RegExp[];
  exclude: RegExp[];
}

// Basename-only glob: `*` is any run of characters, `?` a single one. Case-insensitive.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') {
      source += '.*';
    } else if (ch === '?') {
      source += '.';
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

// Comma-separated mask such as "*.py, *.vue, !*.test.ts"; `!` entries exclude.
export function parseFileMask(mask: string): FileMask {
  const parsed: FileMask = { include: [], exclude: [] };
  for (const raw of mask.split(',')) {
    const part = raw.trim();
    if (part.startsWith('!')) {
      const glob = part.slice(1).trim();
      if (glob) { parsed.exclude.push(globToRegExp(glob)); }
    } else if (part) {
      parsed.include.push(globToRegExp(part));
    }
  }
  return parsed;
}

export function isFileMaskEmpty(mask: FileMask): boolean {
  return mask.include.length === 0 && mask.exclude.length === 0;
}

export function matchesFileMask(fsPath: string, mask: FileMask): boolean {
  const name = fsPath.split(/[\\/]/).pop() || '';
  if (mask.include.length > 0 && !mask.include.some(r => r.test(name))) {
    return false;
  }
  return !mask.exclude.some(r => r.test(name));
}

export interface ContributedCommand {
  id: string;
  title: string;
}

interface CommandContribution {
  command?: unknown;
  title?: unknown;
  category?: unknown;
}

interface PackageJsonWithCommands {
  contributes?: {
    commands?: CommandContribution | CommandContribution[];
    menus?: { commandPalette?: { command?: unknown; when?: unknown }[] };
  };
}

// Titles can be plain strings, localized { value, original } objects, or unresolved "%key%"
// placeholders; the latter have no readable text so they fall back to the command id.
function resolveContributedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return /^%.+%$/.test(value) ? undefined : value;
  }
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value;
  }
  return undefined;
}

// vscode.commands.getCommands() only returns ids, so readable titles come from every
// extension's contributes.commands. Commands hidden from the Command Palette stay hidden.
export function collectContributedCommands(packageJsons: unknown[]): ContributedCommand[] {
  const commands = new Map<string, ContributedCommand>();
  for (const pkg of packageJsons) {
    const contributes = (pkg as PackageJsonWithCommands | undefined)?.contributes;
    if (!contributes) {
      continue;
    }
    const hidden = new Set<unknown>();
    const paletteMenu = contributes.menus?.commandPalette;
    if (Array.isArray(paletteMenu)) {
      paletteMenu.filter(entry => entry && entry.when === 'false').forEach(entry => hidden.add(entry.command));
    }
    const declared = Array.isArray(contributes.commands) ? contributes.commands : contributes.commands ? [contributes.commands] : [];
    for (const contribution of declared) {
      const id = contribution?.command;
      if (typeof id !== 'string' || hidden.has(id) || commands.has(id)) {
        continue;
      }
      const title = resolveContributedString(contribution.title) || id;
      const category = resolveContributedString(contribution.category);
      commands.set(id, { id, title: category ? `${category}: ${title}` : title });
    }
  }
  return Array.from(commands.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function getContributedCommands(): ContributedCommand[] {
  if (!cachedCommands) {
    cachedCommands = collectContributedCommands(vscode.extensions.all.map(ext => ext.packageJSON));
  }
  return cachedCommands;
}


export function activate(context: vscode.ExtensionContext) {
  refreshFileCache();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onWatcherEvent = (uri: vscode.Uri) => {
    if (!isExcludedPath(uri.fsPath)) {
      scheduleRefreshFileCache();
    }
  };
  watcher.onDidCreate(onWatcherEvent);
  watcher.onDidDelete(onWatcherEvent);
  context.subscriptions.push(watcher);
  context.subscriptions.push({ dispose: () => refreshTimer && clearTimeout(refreshTimer) });

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => refreshFileCache()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (
      e.affectsConfiguration('files.exclude') ||
      e.affectsConfiguration('search.exclude') ||
      e.affectsConfiguration('doubleShiftSearchTabs.excludeFolders') ||
      e.affectsConfiguration('doubleShiftSearchTabs.defaultExcludes') ||
      e.affectsConfiguration('doubleShiftSearchTabs.maxFiles')
    ) {
      scheduleRefreshFileCache();
    }
  }));

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document.uri.scheme === 'file') {
        const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
        const maxRecent = config.get<number>('maxRecentFiles') || 10;
        
        let recentFiles = context.workspaceState.get<string[]>('doubleShiftSearchTabs.recentFiles') || [];
        const uriString = editor.document.uri.toString();
        
        recentFiles = recentFiles.filter(u => u !== uriString);
        recentFiles.unshift(uriString);
        
        if (recentFiles.length > maxRecent) {
          recentFiles = recentFiles.slice(0, maxRecent);
        }
        
        context.workspaceState.update('doubleShiftSearchTabs.recentFiles', recentFiles);
      }
    })
  );

  context.subscriptions.push(vscode.extensions.onDidChange(() => { cachedCommands = undefined; }));

  let disposable = vscode.commands.registerCommand('doubleShiftSearchTabs.search', () => showSearchEverywhere(context));
  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('doubleShiftSearchTabs.nextTab', () => activePalette?.cycleTab(1)),
    vscode.commands.registerCommand('doubleShiftSearchTabs.previousTab', () => activePalette?.cycleTab(-1))
  );
}

function scheduleRefreshFileCache() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshFileCache();
  }, REFRESH_DEBOUNCE_MS);
}

export async function findWorkspaceFiles(): Promise<vscode.Uri[]> {
  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
  const maxFiles = Math.max(1, config.get<number>('maxFiles') || DEFAULT_MAX_FILES);
  const files: vscode.Uri[] = [];

  for (const folder of vscode.workspace.workspaceFolders || []) {
    const remaining = maxFiles - files.length;
    if (remaining <= 0) {
      break;
    }
    const exclude = buildExcludeGlob(getExcludePatterns(folder.uri));
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, remaining);
    files.push(...found);
  }

  if (files.length >= maxFiles && !hasWarnedAboutFileCap) {
    hasWarnedAboutFileCap = true;
    vscode.window.showWarningMessage(
      `Double Shift Search Tabs indexed the first ${maxFiles} files in this workspace and skipped the rest. ` +
      'Add large folders to search.exclude or doubleShiftSearchTabs.excludeFolders, or raise doubleShiftSearchTabs.maxFiles.'
    );
  }
  return files;
}

// "Include non-project items": ignore files.exclude, search.exclude and excludeFolders, skipping
// only .git. findFiles cannot express "no setting excludes except .git", so each top-level
// entry is searched separately with excludes disabled (null) and the root .git is never walked.
export async function findAllWorkspaceFiles(): Promise<vscode.Uri[]> {
  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
  const maxFiles = Math.max(1, config.get<number>('maxFiles') || DEFAULT_MAX_FILES);
  const files: vscode.Uri[] = [];

  for (const folder of vscode.workspace.workspaceFolders || []) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder.uri);
    } catch (e) {
      continue;
    }
    for (const [name, fileType] of entries) {
      const remaining = maxFiles - files.length;
      if (remaining <= 0) {
        return files;
      }
      if (name === '.git') {
        continue;
      }
      const uri = vscode.Uri.joinPath(folder.uri, name);
      if (fileType & vscode.FileType.Directory) {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'), null, remaining);
        files.push(...found.filter(file => !/[\\/]\.git[\\/]/.test(file.fsPath)));
      } else if (fileType & vscode.FileType.File) {
        files.push(uri);
      }
    }
  }
  return files;
}

function refreshFileCache() {
  cachedFilesPromise = findWorkspaceFiles();
  cachedDirsPromise = cachedFilesPromise.then(deriveDirectories);
  cachedNonProjectFilesPromise = undefined;
  cachedNonProjectDirsPromise = undefined;
}

function deriveDirectories(files: vscode.Uri[]): vscode.Uri[] {
  const dirSet = new Set<string>();
  for (const file of files) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
    if (!workspaceFolder) {continue;}

    let currentPath = path.dirname(file.fsPath);
    const rootPath = workspaceFolder.uri.fsPath;

    // On Windows, fsPath casing (e.g. the drive letter) isn't guaranteed consistent
    // between a workspace folder URI and a file URI, so compare case-insensitively.
    const normalizeForComparison = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p;
    const normalizedRootPath = normalizeForComparison(rootPath);

    while (currentPath.length >= rootPath.length && normalizeForComparison(currentPath).startsWith(normalizedRootPath)) {
      if (dirSet.has(currentPath)) {break;}
      dirSet.add(currentPath);

      const nextPath = path.dirname(currentPath);
      if (nextPath === currentPath) {break;} // Reached root
      currentPath = nextPath;
    }
  }
  return Array.from(dirSet).map(dir => vscode.Uri.file(dir));
}

function getNonProjectFileCache(): [Thenable<vscode.Uri[]>, Thenable<vscode.Uri[]>] {
  if (!cachedNonProjectFilesPromise || !cachedNonProjectDirsPromise) {
    cachedNonProjectFilesPromise = findAllWorkspaceFiles();
    cachedNonProjectDirsPromise = cachedNonProjectFilesPromise.then(deriveDirectories);
  }
  return [cachedNonProjectFilesPromise, cachedNonProjectDirsPromise];
}

interface PaletteData {
  openEditors: SearchItem[];
  fileItems: SearchItem[];
  dirItems: SearchItem[];
  textSearchFiles: vscode.Uri[];
  stagedUris: Set<string>;
  deprioritizedFolders: Set<string>;
}

function loadPaletteState(context: vscode.ExtensionContext): PaletteState {
  const saved = context.workspaceState.get<Partial<PaletteState>>(PALETTE_STATE_KEY) || {};
  const state: PaletteState = { ...DEFAULT_PALETTE_STATE, ...saved };
  const rememberLastTab = vscode.workspace.getConfiguration('doubleShiftSearchTabs').get<boolean>('rememberLastTab', true);
  if (!rememberLastTab || !SEARCH_TABS.includes(state.tab)) {
    state.tab = 'all';
  }
  return state;
}

// Quick input buttons have no pressed state and ignore ThemeIcon colours, so the title bar uses
// bundled codicon SVGs (media/icons) with an "on" variant drawn like VS Code's own find toggles.
function buildTitleButtons(state: PaletteState, extensionUri: vscode.Uri): PaletteButton[] {
  const icon = (name: string, on: boolean) => {
    const file = (theme: 'light' | 'dark') =>
      vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-${on ? 'active' : 'off'}-${theme}.svg`);
    return { light: file('light'), dark: file('dark') };
  };
  const toggle = (action: ToggleKey, name: string, label: string): PaletteButton => ({
    action,
    iconPath: icon(name, state[action]),
    tooltip: label
  });
  const mask = state.fileMask.trim();
  const tabButtons = SEARCH_TABS.map((tab): PaletteButton => ({
    action: 'tab',
    tab,
    iconPath: icon(TAB_ICONS[tab], tab === state.tab),
    tooltip: TAB_LABELS[tab]
  }));
  // Buttons are always right-aligned in one group, so a non-clickable divider splits tabs from filters.
  const divider: PaletteButton = {
    action: 'divider',
    iconPath: {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'divider-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'divider-dark.svg')
    }
  };
  return [
    ...tabButtons,
    divider,
    toggle('matchCase', 'case-sensitive', 'Match Case'),
    toggle('wholeWord', 'whole-word', 'Words'),
    toggle('regex', 'regex', 'Regex'),
    { action: 'fileMask', iconPath: icon('filter', mask !== ''), tooltip: 'File Mask' },
    toggle('includeNonProject', 'eye', 'Include Non-Project Items')
  ];
}

// Parent folder of a workspace-relative path, shown next to the file name ('' at the root).
export function getParentPath(relativePath: string): string {
  const slash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

function createUriItem(uri: vscode.Uri, type: 'editor' | 'file' | 'directory'): SearchItem {
  const relativePath = vscode.workspace.asRelativePath(uri);
  return {
    label: path.basename(uri.fsPath),
    description: getParentPath(relativePath),
    iconPath: type === 'directory' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File,
    resourceUri: uri,
    relativePath,
    type: type,
    uri: uri,
    alwaysShow: true,
    buttons: type === 'directory' ? undefined : [OPEN_TO_SIDE_BUTTON]
  };
}

function getFileRank(uri: vscode.Uri, stagedUris: Set<string>, deprioritizedFolders: Set<string>): number {
  if (stagedUris.has(uri.toString())) { return 0; }
  if (isInDeprioritizedFolder(uri.fsPath, deprioritizedFolders)) { return 2; }
  return 1;
}

async function loadPaletteData(context: vscode.ExtensionContext, state: PaletteState): Promise<PaletteData> {
  const [filesPromise, dirsPromise]: [Thenable<vscode.Uri[]>, Thenable<vscode.Uri[]>] = state.includeNonProject
    ? getNonProjectFileCache()
    : [cachedFilesPromise || Promise.resolve([]), cachedDirsPromise || Promise.resolve([])];
  const [allFiles, allDirs, stagedUris] = await Promise.all([filesPromise, dirsPromise, getStagedFileUris()]);

  const deprioritizedFolders = getDeprioritizedFolderSet();
  const mask = parseFileMask(state.fileMask);
  const maskActive = !isFileMaskEmpty(mask);
  const passesMask = (uri: vscode.Uri): boolean => !maskActive || matchesFileMask(uri.fsPath, mask);

  const openEditors: SearchItem[] = [];
  const addedUris = new Set<string>();
  const recentUris = context.workspaceState.get<string[]>('doubleShiftSearchTabs.recentFiles') || [];

  for (const uriStr of recentUris) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      addedUris.add(uriStr);
      if (passesMask(uri)) {
        openEditors.push(createUriItem(uri, 'editor'));
      }
    } catch (e) {}
  }

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri;
        const uriStr = uri.toString();
        if (!addedUris.has(uriStr)) {
          addedUris.add(uriStr);
          if (passesMask(uri)) {
            openEditors.push(createUriItem(uri, 'editor'));
          }
        }
      }
    }
  }

  const textSearchFiles = maskActive ? allFiles.filter(passesMask) : allFiles;

  const openEditorUris = new Set(openEditors.map(e => e.uri?.toString()));
  const fileItems: SearchItem[] = textSearchFiles
    .filter(uri => !openEditorUris.has(uri.toString()))
    .sort((a, b) => getFileRank(a, stagedUris, deprioritizedFolders) - getFileRank(b, stagedUris, deprioritizedFolders))
    .map(uri => createUriItem(uri, 'file'));

  const getPathDepth = (fsPath: string): number => fsPath.split(/[\\/]/).length;

  // A mask describes file names, so folders are hidden while one is active.
  const dirItems: SearchItem[] = maskActive ? [] : [...allDirs]
    .sort((a, b) => {
      const aDeprioritized = isInDeprioritizedFolder(a.fsPath, deprioritizedFolders);
      const bDeprioritized = isInDeprioritizedFolder(b.fsPath, deprioritizedFolders);
      if (aDeprioritized !== bDeprioritized) { return aDeprioritized ? 1 : -1; }
      return getPathDepth(a.fsPath) - getPathDepth(b.fsPath);
    })
    .map(uri => createUriItem(uri, 'directory'));

  return { openEditors, fileItems, dirItems, textSearchFiles, stagedUris, deprioritizedFolders };
}

export interface ResultGroup {
  label: string;
  items: SearchItem[];
}

// Flattens result groups behind separator headers, dropping empty groups. A group without a
// label (status rows such as the text search spinner) gets a plain divider instead of a header,
// so it does not read as part of the group above it, and nothing at all when it comes first.
export function buildGroupedItems(groups: ResultGroup[]): SearchItem[] {
  const items: SearchItem[] = [];
  for (const group of groups) {
    if (group.items.length === 0) {
      continue;
    }
    if (group.label || items.length > 0) {
      items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator, type: 'separator' });
    }
    items.push(...group.items);
  }
  return items;
}

interface FileResults {
  editors: SearchItem[];
  dirs: SearchItem[];
  files: SearchItem[];
  // A query ending in a path separator puts folders ahead of recent editors.
  dirsFirst: boolean;
}

function getFileResultGroups(results: FileResults): ResultGroup[] {
  const recent: ResultGroup = { label: 'Recent', items: results.editors };
  const folders: ResultGroup = { label: 'Folders', items: results.dirs };
  return [...(results.dirsFirst ? [folders, recent] : [recent, folders]), { label: 'Files', items: results.files }];
}

// An invalid regex is reported by the caller; here it simply matches nothing.
function filterFileItems(data: PaletteData, value: string, options: TextSearchOptions): FileResults {
  const isDirPriority = value.endsWith('/') || value.endsWith('\\');
  const matchValue = isDirPriority ? value.slice(0, -1) : value;
  const matcher = createNameMatcher(matchValue, options);
  const match: NameMatcher = typeof matcher === 'function' ? matcher : () => null;

  const filteredDirs = filterAndScoreItems(data.dirItems, match, item =>
    isInDeprioritizedFolder(item.uri!.fsPath, data.deprioritizedFolders) ? 1 : 0);
  const filteredEditors = filterAndScoreItems(data.openEditors, match, () => 0);
  const filteredFiles = filterAndScoreItems(data.fileItems, match, item =>
    getFileRank(item.uri!, data.stagedUris, data.deprioritizedFolders));

  return {
    editors: filteredEditors,
    dirs: filteredDirs.slice(0, isDirPriority ? 50 : 20),
    files: filteredFiles.slice(0, 100),
    dirsFirst: isDirPriority
  };
}

// Text search walks files in priority order: active editor, open editors, staged files, then
// everything else with deprioritized folders last.
function sortFilesForTextSearch(data: PaletteData): vscode.Uri[] {
  const activeUriString = vscode.window.activeTextEditor?.document.uri.toString();
  const openUris = new Set(data.openEditors.map(e => e.uri?.toString()));

  return [...data.textSearchFiles].sort((a, b) => {
    const aUri = a.toString();
    const bUri = b.toString();

    if (aUri === activeUriString && bUri !== activeUriString) { return -1; }
    if (aUri !== activeUriString && bUri === activeUriString) { return 1; }

    const aIsOpen = openUris.has(aUri);
    const bIsOpen = openUris.has(bUri);

    if (aIsOpen && !bIsOpen) { return -1; }
    if (!aIsOpen && bIsOpen) { return 1; }

    const aIsStaged = data.stagedUris.has(aUri);
    const bIsStaged = data.stagedUris.has(bUri);

    if (aIsStaged && !bIsStaged) { return -1; }
    if (!aIsStaged && bIsStaged) { return 1; }

    const aDeprioritized = isInDeprioritizedFolder(a.fsPath, data.deprioritizedFolders);
    const bDeprioritized = isInDeprioritizedFolder(b.fsPath, data.deprioritizedFolders);

    if (aDeprioritized && !bDeprioritized) { return 1; }
    if (!aDeprioritized && bDeprioritized) { return -1; }

    return 0;
  });
}

export function getSymbolIconId(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Class: return 'symbol-class';
    case vscode.SymbolKind.Function: return 'symbol-method';
    case vscode.SymbolKind.Method: return 'symbol-method';
    case vscode.SymbolKind.Variable: return 'symbol-variable';
    case vscode.SymbolKind.Interface: return 'symbol-interface';
    case vscode.SymbolKind.Module: return 'symbol-namespace';
    case vscode.SymbolKind.Struct: return 'symbol-struct';
    case vscode.SymbolKind.Enum: return 'symbol-enum';
    default: return 'symbol-misc';
  }
}

// SymbolKind member names split into words, e.g. TypeParameter -> "Type Parameter".
export function getSymbolKindName(kind: vscode.SymbolKind): string {
  const name: string | undefined = vscode.SymbolKind[kind];
  return name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : 'Symbol';
}

// "Class · line 12", or "Method in UserService · line 40" when the symbol has a container.
export function formatSymbolDescription(kind: vscode.SymbolKind, containerName: string, line: number): string {
  const container = containerName ? ` in ${containerName}` : '';
  return `${getSymbolKindName(kind)}${container} · line ${line}`;
}

// Symbol providers do their own case-insensitive fuzzy matching and know nothing about regexes, so
// with any filter on they are asked for the longest plain word in the query and the names are then
// checked with the same matcher as files and folders.
async function fetchSymbolItems(
  query: string,
  classesOnly: boolean,
  options: TextSearchOptions,
  includeNonProject: boolean
): Promise<SearchItem[]> {
  const filtered = options.matchCase || options.wholeWord || options.regex;
  const providerQuery = options.regex
    ? (query.match(/[A-Za-z0-9_]+/g) || []).reduce((a, b) => b.length > a.length ? b : a, '')
    : query;
  if (!providerQuery) {
    return [];
  }
  const matcher = filtered ? createNameMatcher(query, options) : undefined;
  if (matcher && typeof matcher !== 'function') {
    return [];
  }
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    providerQuery
  ) || [];

  return symbols
    .filter(sym => !classesOnly || CLASS_SYMBOL_KINDS.has(sym.kind))
    .filter(sym => !matcher || matcher(sym.name) !== null)
    .filter(sym => includeNonProject || !isExcludedPath(sym.location.uri.fsPath))
    .map((sym): SearchItem => ({
      label: sym.name,
      description: formatSymbolDescription(sym.kind, sym.containerName, sym.location.range.start.line + 1),
      detail: vscode.workspace.asRelativePath(sym.location.uri),
      iconPath: new vscode.ThemeIcon(getSymbolIconId(sym.kind)),
      type: 'symbol',
      symbol: sym,
      alwaysShow: true,
      buttons: [OPEN_TO_SIDE_BUTTON]
    }));
}

// Commands contributed by VS Code's built-in and installed extensions. Words and Regex apply, but
// Match Case does not: nobody remembers how a command title is capitalised.
function buildActionItems(query: string, maxResults: number, options: TextSearchOptions): SearchItem[] {
  const matcher = createNameMatcher(query, { ...options, matchCase: false });
  const match: NameMatcher = typeof matcher === 'function' ? matcher : () => null;
  const scored: { command: ContributedCommand; score: number }[] = [];
  for (const command of getContributedCommands()) {
    const score = match(command.title);
    if (score !== null) {
      scored.push({ command, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(({ command }): SearchItem => ({
    label: command.title,
    description: command.id,
    iconPath: new vscode.ThemeIcon('symbol-event'),
    type: 'command',
    commandId: command.id,
    alwaysShow: true
  }));
}

function openSearchItem(item: SearchItem, viewColumn?: vscode.ViewColumn) {
  const showOptions: vscode.TextDocumentShowOptions | undefined = viewColumn ? { viewColumn } : undefined;
  if (item.type === 'editor' || item.type === 'file') {
    if (item.uri) {
      vscode.workspace.openTextDocument(item.uri).then(doc => {
        vscode.window.showTextDocument(doc, showOptions);
      });
    }
  } else if (item.type === 'directory') {
    if (item.uri) {
      vscode.commands.executeCommand('revealInExplorer', item.uri);
    }
  } else if (item.type === 'symbol' && item.symbol) {
    vscode.workspace.openTextDocument(item.symbol.location.uri).then(doc => {
      vscode.window.showTextDocument(doc, {
        ...showOptions,
        selection: item.symbol!.location.range
      });
    });
  } else if (item.type === 'text' && item.uri) {
    vscode.workspace.openTextDocument(item.uri).then(doc => {
      vscode.window.showTextDocument(doc, showOptions).then(editor => {
        if (item.lineNumber) {
          const pos = new vscode.Position(item.lineNumber - 1, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      });
    });
  }
}

async function showSearchEverywhere(context: vscode.ExtensionContext, restore?: { state: PaletteState; value: string }) {
  if (activeSearchCts) {
    activeSearchCts.cancel();
    activeSearchCts.dispose();
  }
  activeSearchCts = new vscode.CancellationTokenSource();
  const currentCts = activeSearchCts;

  const state: PaletteState = restore ? { ...restore.state } : loadPaletteState(context);
  const quickPick = vscode.window.createQuickPick<SearchItem>();
  // Results are filtered here on label and path/snippet; the detail line (a symbol's or text hit's
  // path) is never matched against the query, so VS Code should not highlight it either.
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = false;

  let isDisposed = false;
  let data: PaletteData | undefined;
  let loadId = 0;
  let symbolTimeout: NodeJS.Timeout | undefined;
  let textSearchId = 0;

  const updateChrome = () => {
    quickPick.title = toUnbreakableTitle(`Search Everywhere - ${TAB_LABELS[state.tab]}`);
    const mask = state.fileMask.trim();
    quickPick.placeholder = mask ? `${TAB_PLACEHOLDERS[state.tab]} - mask: ${mask}` : TAB_PLACEHOLDERS[state.tab];
    quickPick.buttons = buildTitleButtons(state, context.extensionUri);
  };

  const persistState = () => {
    context.workspaceState.update(PALETTE_STATE_KEY, state);
  };

  const controller: PaletteController = {
    setTab: tab => {
      if (tab === state.tab) {
        return;
      }
      state.tab = tab;
      persistState();
      updateChrome();
      handleValueChange(quickPick.value);
    },
    cycleTab: direction => controller.setTab(cycleTab(state.tab, direction)),
    toggle: key => {
      state[key] = !state[key];
      persistState();
      updateChrome();
      if (key === 'includeNonProject') {
        loadData();
      } else {
        handleValueChange(quickPick.value);
      }
    }
  };

  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
  const rememberLastQuery = config.get<boolean>('rememberLastQuery', true);

  quickPick.onDidHide(() => {
    if (rememberLastQuery) {
      context.workspaceState.update(LAST_QUERY_KEY, quickPick.value);
    }
    isDisposed = true;
    currentCts.cancel();
    if (activePalette === controller) {
      activePalette = undefined;
      vscode.commands.executeCommand('setContext', PALETTE_VISIBLE_CONTEXT, false);
    }
    quickPick.dispose();
  });

  const activeEditor = vscode.window.activeTextEditor;
  if (restore) {
    quickPick.value = restore.value;
  } else if (config.get<boolean>('useSelectionAsQuery') && activeEditor && !activeEditor.selection.isEmpty) {
    quickPick.value = activeEditor.document.getText(activeEditor.selection);
  } else if (rememberLastQuery) {
    const lastQuery = context.workspaceState.get<string>(LAST_QUERY_KEY) || '';
    quickPick.value = lastQuery;
    // Pre-select the previous query so typing replaces it. valueSelection is only typed on InputBox,
    // but every quick input supports it at runtime; where it is missing the text is simply not selected.
    (quickPick as { valueSelection?: readonly [number, number] }).valueSelection = [0, lastQuery.length];
  }

  updateChrome();
  quickPick.busy = true;
  quickPick.show();
  activePalette = controller;
  vscode.commands.executeCommand('setContext', PALETTE_VISIBLE_CONTEXT, true);

  async function loadData() {
    const currentLoadId = ++loadId;
    quickPick.busy = true;
    let loaded: PaletteData;
    try {
      loaded = await loadPaletteData(context, state);
    } catch (e) {
      console.error('Failed to load search data', e);
      if (!isDisposed && currentLoadId === loadId) {
        quickPick.busy = false;
      }
      return;
    }
    if (isDisposed || currentLoadId !== loadId) {
      return;
    }
    data = loaded;
    quickPick.busy = false;
    handleValueChange(quickPick.value);
  }

  // showInputBox would replace the quick pick anyway, so close it, ask for the mask, then
  // reopen with the same tab, query and toggles.
  async function editFileMask() {
    const value = quickPick.value;
    quickPick.hide();
    const mask = await vscode.window.showInputBox({
      title: 'File Mask',
      prompt: 'Comma-separated file name patterns. Prefix a pattern with ! to exclude it. Leave empty to clear.',
      placeHolder: '*.py, *.vue, !*.test.ts',
      value: state.fileMask
    });
    if (mask !== undefined) {
      state.fileMask = mask.trim();
      persistState();
    }
    showSearchEverywhere(context, { state, value });
  }

  function handleValueChange(value: string) {
    if (!data || isDisposed) {
      return;
    }
    if (symbolTimeout) {
      clearTimeout(symbolTimeout);
    }

    const currentSearchId = ++textSearchId;
    const tab = state.tab;
    const options: TextSearchOptions = { matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex };

    const matcher = createNameMatcher(value, options);
    if (value && typeof matcher !== 'function') {
      quickPick.items = [{ label: '$(warning) Invalid regular expression:', description: matcher.error, alwaysShow: true, type: 'action' }];
      quickPick.busy = false;
      return;
    }

    if (tab === 'actions') {
      const actionItems = buildActionItems(value, ACTIONS_TAB_MAX_RESULTS, options);
      quickPick.items = actionItems.length > 0 ? actionItems : [{ label: '$(warning) No results found', alwaysShow: true, type: 'action' }];
      quickPick.busy = false;
      return;
    }

    const fileResults = tab === 'all' || tab === 'files' ? filterFileItems(data, value, options) : undefined;
    const fileItems = fileResults ? buildGroupedItems(getFileResultGroups(fileResults)) : [];

    if (!value) {
      if (tab === 'all' || tab === 'files') {
        quickPick.items = fileItems.length > 0
          ? fileItems
          : [{ label: 'No files found in workspace', description: '(The workspace may still be indexing)', type: 'action' }];
      } else {
        quickPick.items = [];
      }
      quickPick.busy = false;
      return;
    }

    if (tab === 'files') {
      quickPick.items = fileItems.length > 0 ? fileItems : [{ label: '$(warning) No results found', alwaysShow: true, type: 'action' }];
      quickPick.busy = false;
      return;
    }

    quickPick.items = fileItems.length > 0 ? fileItems : [{ label: '$(sync~spin) Searching...', alwaysShow: true, type: 'action' }];

    const searchData = data;
    symbolTimeout = setTimeout(() => runDeepSearch(value, tab, currentSearchId, searchData, fileResults, options), SEARCH_DEBOUNCE_MS);
  }

  async function runDeepSearch(
    value: string,
    tab: SearchTab,
    currentSearchId: number,
    searchData: PaletteData,
    fileResults: FileResults | undefined,
    options: TextSearchOptions
  ) {
    if (isDisposed) { return; }
    const isCurrent = () => currentSearchId === textSearchId && !isDisposed;
    const showItems = (items: SearchItem[]) => {
      if (isCurrent() && quickPick.value === value) {
        quickPick.items = items;
      }
    };

    // Symbols and file contents are searched in parallel and shown as each arrives: a language
    // server that is still indexing can take minutes to answer and must not hold up the rest.
    let symbolItems: SearchItem[] | undefined = tab === 'text' ? [] : undefined;
    let textItems: SearchItem[] | undefined = tab === 'classes' || tab === 'symbols' ? [] : undefined;
    const actionItems = tab === 'all' ? buildActionItems(value, ALL_TAB_MAX_ACTIONS, options) : [];
    const status = (label: string): ResultGroup => ({ label: '', items: [{ label: `$(sync~spin) ${label}`, alwaysShow: true, type: 'action' }] });
    const noResults: SearchItem = { label: '$(warning) No results found', alwaysShow: true, type: 'action' };

    const render = () => {
      if (!isCurrent()) { return; }
      if (tab === 'classes' || tab === 'symbols') {
        if (symbolItems === undefined) {
          showItems(buildGroupedItems([status('Waiting for language servers (they may still be indexing)...')]));
        } else {
          showItems(symbolItems.length > 0 ? symbolItems.slice(0, SYMBOLS_TAB_MAX_RESULTS) : [noResults]);
        }
        return;
      }

      // All tab: open editors, then symbols, then folders and files, then a few matching actions,
      // then text matches. The Text tab has one group and no header; status rows never get one.
      const groups: ResultGroup[] = [];
      if (tab === 'all' && fileResults) {
        groups.push(
          { label: 'Recent', items: fileResults.editors },
          { label: 'Symbols', items: (symbolItems || []).slice(0, 50) },
          { label: 'Folders', items: fileResults.dirs },
          { label: 'Files', items: fileResults.files },
          { label: 'Actions', items: actionItems }
        );
      }
      groups.push({ label: tab === 'text' ? '' : 'Text', items: textItems || [] });
      const pending = [symbolItems === undefined ? 'symbols' : '', textItems === undefined ? 'file contents' : ''].filter(Boolean);
      if (pending.length > 0) {
        groups.push(status(`Searching ${pending.join(' and ')}...`));
      }
      const items = buildGroupedItems(groups);
      showItems(items.length > 0 ? items : [noResults]);
    };

    quickPick.busy = true;
    render();
    const symbolSearch = symbolItems !== undefined ? Promise.resolve() :
      fetchSymbolItems(value, tab === 'classes', options, state.includeNonProject)
        .then(items => { symbolItems = items; }, e => { symbolItems = []; console.error('Failed to fetch symbols', e); })
        .then(render);
    // An invalid regex never gets here: handleValueChange reports it before searching.
    const isTextTab = tab === 'text';
    const textSearch = textItems !== undefined ? Promise.resolve() :
      searchFileContents(
        value,
        sortFilesForTextSearch(searchData),
        () => currentSearchId !== textSearchId || isDisposed || currentCts.token.isCancellationRequested,
        isTextTab ? TEXT_TAB_MAX_RESULTS : 50,
        { ...options, maxMatchesPerFile: isTextTab ? TEXT_TAB_MAX_MATCHES_PER_FILE : 1 }
      )
        .then(items => { textItems = items; }, e => { textItems = []; console.error('Failed to search file contents', e); })
        .then(render);

    await Promise.all([symbolSearch, textSearch]);
    if (isCurrent()) {
      quickPick.busy = false;
    }
  }

  quickPick.onDidChangeValue(handleValueChange);

  quickPick.onDidTriggerButton(button => {
    const { action, tab } = button as PaletteButton;
    if (action === 'tab') {
      if (tab) {
        controller.setTab(tab);
      }
    } else if (action === 'divider') {
      return;
    } else if (action === 'fileMask') {
      editFileMask();
    } else {
      controller.toggle(action);
    }
  });

  quickPick.onDidTriggerItemButton(event => {
    if (event.item.type === 'separator') {
      return;
    }
    openSearchItem(event.item, vscode.ViewColumn.Beside);
    quickPick.hide();
  });

  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    // Status rows and group headers are not results; separators are unselectable, but stay safe.
    if (selected?.type === 'action' || selected?.type === 'separator') {
      return;
    }
    if (selected?.type === 'command' && selected.commandId) {
      quickPick.hide();
      vscode.commands.executeCommand(selected.commandId).then(undefined, e => {
        vscode.window.showErrorMessage(`Failed to run ${selected.commandId}: ${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }
    if (selected) {
      openSearchItem(selected);
    }
    quickPick.hide();
  });

  await loadData();
}

export function deactivate() { }

export interface FileContentSearchOptions extends TextSearchOptions {
  maxMatchesPerFile: number;
}

const DEFAULT_FILE_CONTENT_SEARCH_OPTIONS: FileContentSearchOptions = {
  matchCase: false, wholeWord: false, regex: false, maxMatchesPerFile: 1
};

export async function searchFileContents(
  query: string,
  files: vscode.Uri[],
  isCancelled: () => boolean,
  maxResults = 50,
  options: FileContentSearchOptions = DEFAULT_FILE_CONTENT_SEARCH_OPTIONS
): Promise<SearchItem[]> {
  const results: SearchItem[] = [];
  const built = buildTextSearchRegex(query, options);
  if ('error' in built) {
    return results;
  }
  const queryRegex = built.regex;
  const batchSize = 20;

  const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
  const excludeExtensionsList = config.get<string[]>('excludeExtensions') || [
    '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.mp4', '.mp3',
    '.pdb', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.jar', '.pyc', '.nupkg', '.woff', '.woff2', '.ttf', '.otf', '.db', '.sqlite'
  ];
  const skipExtensions = new Set(excludeExtensionsList.map(ext => ext.toLowerCase()));

  for (let i = 0; i < files.length; i += batchSize) {
    if (isCancelled() || results.length >= maxResults) {
      break;
    }

    const batch = files.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (uri): Promise<SearchItem[]> => {
      try {
        if (isCancelled()) {
          return [];
        }
        if (uri.scheme !== 'file') {
          return [];
        }

        const ext = path.extname(uri.fsPath).toLowerCase();
        if (skipExtensions.has(ext)) {
          return [];
        }

        let content: string;
        const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        if (openDoc) {
          content = openDoc.getText();
        } else {
          const stat = await fs.stat(uri.fsPath);
          if (stat.size > 1024 * 1024) {
            return [];
          }

          let fd;
          try {
            fd = await fs.open(uri.fsPath, 'r');
            const buffer = Buffer.alloc(4096);
            const { bytesRead } = await fd.read(buffer, 0, 4096, 0);
            
            let isBinary = false;
            for (let j = 0; j < bytesRead; j++) {
              if (buffer[j] === 0x00) {
                isBinary = true;
                break;
              }
            }
            if (isBinary) {
              return [];
            }
          } catch (e) {
            // Ignore open/read errors and just skip file
            return [];
          } finally {
            if (fd) {
              await fd.close();
            }
          }

          content = await fs.readFile(uri.fsPath, 'utf8');
        }

        const fileResults: SearchItem[] = [];
        // The regex is shared across files, but this loop never awaits, so lastIndex is safe.
        queryRegex.lastIndex = 0;
        let lineNumber = 1;
        let countedUpTo = 0;
        let match: RegExpExecArray | null;

        while (fileResults.length < options.maxMatchesPerFile && (match = queryRegex.exec(content)) !== null) {
          const index = match.index;
          const startOfLine = content.lastIndexOf('\n', index) + 1;
          const rawEndOfLine = content.indexOf('\n', index);
          const endOfLine = rawEndOfLine === -1 ? content.length : rawEndOfLine;

          // Cap the snippet length, but center the window on the match itself so a hit
          // past offset 500 on a long line still shows up in the preview.
          const maxSnippetLength = 500;
          let sliceStart = startOfLine;
          let sliceEnd = endOfLine;
          if (sliceEnd - sliceStart > maxSnippetLength) {
            sliceStart = Math.max(startOfLine, index - Math.floor(maxSnippetLength / 2));
            sliceEnd = Math.min(endOfLine, sliceStart + maxSnippetLength);
          }

          const snippet = content.slice(sliceStart, sliceEnd);
          const matchOffset = index - sliceStart;
          lineNumber += content.slice(countedUpTo, index).split('\n').length - 1;
          countedUpTo = index;

          // Same centering applies to the shorter display window, so the match still
          // survives being cropped down to a description-sized preview.
          const maxDescriptionLength = 80;
          let description: string;
          if (snippet.length > maxDescriptionLength) {
            let descStart = Math.max(0, matchOffset - Math.floor(maxDescriptionLength / 2));
            const descEnd = Math.min(snippet.length, descStart + maxDescriptionLength);
            descStart = Math.max(0, descEnd - maxDescriptionLength);
            const prefix = descStart > 0 ? '...' : '';
            const suffix = descEnd < snippet.length ? '...' : '';
            description = `${prefix}${snippet.slice(descStart, descEnd).trim()}${suffix}`;
          } else {
            description = snippet.trim();
          }

          fileResults.push({
            label: `${path.basename(uri.fsPath)}:${lineNumber}`,
            description: description,
            detail: vscode.workspace.asRelativePath(uri),
            iconPath: new vscode.ThemeIcon('text-size'),
            type: 'text',
            uri: uri,
            lineNumber: lineNumber,
            alwaysShow: true,
            buttons: [OPEN_TO_SIDE_BUTTON]
          });

          // One result per line: resume after this line, which also steps past empty matches.
          queryRegex.lastIndex = endOfLine + 1;
        }
        return fileResults;
      } catch (e) {
        return [];
      }
    }));

    for (const fileResults of batchResults) {
      for (const result of fileResults) {
        if (results.length < maxResults) {
          results.push(result);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return results;
}

