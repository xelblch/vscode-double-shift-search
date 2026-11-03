import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { writeFile, unlink } from 'fs/promises';
import {
  fuzzyMatch, fuzzyScore, searchFileContents, getStagedFileUris, getDeprioritizedFolderSet, isInDeprioritizedFolder, expandBraces,
  buildExcludeGlob, getExcludePatterns, getExcludedFolderNames, DEFAULT_EXCLUDED_FOLDERS, buildTextSearchRegex, globToRegExp, parseFileMask, isFileMaskEmpty,
  matchesFileMask, cycleTab, toUnbreakableTitle, createNameMatcher, NameMatcher, collectContributedCommands, SEARCH_TABS, TextSearchOptions, getParentPath,
  getSymbolIconId, getSymbolKindName, formatSymbolDescription, buildGroupedItems, SearchItem
} from '../../extension';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Command is registered', async () => {
    const ext = vscode.extensions.getExtension('xelblch.double-shift-search-tabs');
    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    const hasCommand = commands.includes('doubleShiftSearchTabs.search');
    assert.strictEqual(hasCommand, true);
  });

  test('Tab and filter commands are registered', async () => {
    const ext = vscode.extensions.getExtension('xelblch.double-shift-search-tabs');
    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const id of ['nextTab', 'previousTab']) {
      assert.ok(commands.includes(`doubleShiftSearchTabs.${id}`), `doubleShiftSearchTabs.${id} should be registered`);
    }
  });
});

suite('Fuzzy Match Edge Cases', () => {
  test('Empty pattern matches everything', () => {
    assert.strictEqual(fuzzyMatch('', 'any text'), true);
    assert.strictEqual(fuzzyMatch('   ', 'any text'), true);
  });

  test('Case insensitivity', () => {
    assert.strictEqual(fuzzyMatch('FOO', 'foo bar'), true);
    assert.strictEqual(fuzzyMatch('foo', 'FOO BAR'), true);
  });

  test('Multi-term matching', () => {
    assert.strictEqual(fuzzyMatch('foo bar', 'this is a foo and a bar'), true);
    assert.strictEqual(fuzzyMatch('bar foo', 'this is a foo and a bar'), true);
    assert.strictEqual(fuzzyMatch('foo baz', 'this is a foo and a bar'), false);
  });

  test('Partial term matching', () => {
    assert.strictEqual(fuzzyMatch('exten', 'extension.ts'), true);
    assert.strictEqual(fuzzyMatch('pack js', 'package.json'), true);
  });
});

suite('Acronym / Hump Fuzzy Matching', () => {
  test('Acronym matches consume hump-boundary characters in order', () => {
    assert.strictEqual(fuzzyMatch('gua', 'getUserAccount.ts'), true);
    assert.strictEqual(fuzzyMatch('GUA', 'getUserAccount.ts'), true); // Case-insensitive
    assert.notStrictEqual(fuzzyScore('gua', 'getUserAccount.ts'), null);
  });

  test('fuzzyScore with matchCase only accepts the exact letter case', () => {
    assert.strictEqual(fuzzyMatch('User', 'users', true), false);
    assert.strictEqual(fuzzyMatch('User', 'UserService.py', true), true);
    assert.strictEqual(fuzzyMatch('gUA', 'getUserAccount.ts', true), true);
    assert.strictEqual(fuzzyMatch('GUA', 'getUserAccount.ts', true), false);
    assert.strictEqual(fuzzyMatch('user', 'users', false), true);
  });

  test('createNameMatcher applies Match Case, Words and Regex to names', () => {
    const matcher = (query: string, matchCase: boolean, wholeWord: boolean, regex: boolean): NameMatcher => {
      const result = createNameMatcher(query, { matchCase, wholeWord, regex });
      assert.strictEqual(typeof result, 'function');
      return result as NameMatcher;
    };
    assert.notStrictEqual(matcher('gua', false, false, false)('getUserAccount.ts'), null);
    assert.strictEqual(matcher('user', false, true, false)('users'), null);
    assert.notStrictEqual(matcher('user', false, true, false)('user.py'), null);
    assert.strictEqual(matcher('User', true, true, false)('user.py'), null);
    assert.notStrictEqual(matcher('^test_.*\\.py$', false, false, true)('test_views.py'), null);
    assert.strictEqual(matcher('^test_.*\\.py$', false, false, true)('views_test.py'), null);
    assert.strictEqual(matcher('gua', false, false, true)('getUserAccount.ts'), null);
    assert.strictEqual(matcher('', false, true, false)('user.py'), 0);
    assert.ok('error' in (createNameMatcher('(', { matchCase: false, wholeWord: false, regex: true }) as { error: string }));
  });

  test('Acronym match fails when characters are not on hump boundaries in order', () => {
    // 'e', 't', 'a' exist in the text but not as hump-boundary characters in this order.
    assert.strictEqual(fuzzyMatch('eta', 'getUserAccount.ts'), false);
    assert.strictEqual(fuzzyScore('eta', 'getUserAccount.ts'), null);
  });

  test('Acronym match fails when pattern exceeds available hump characters', () => {
    assert.strictEqual(fuzzyMatch('guax', 'getUserAccount.ts'), false);
  });

  test('Exact substring match always outranks acronym match', () => {
    const substringScore = fuzzyScore('user', 'getUserAccount.ts');
    const acronymScore = fuzzyScore('gua', 'getUserAccount.ts');
    assert.ok(substringScore !== null && acronymScore !== null);
    assert.ok((substringScore as number) > (acronymScore as number));
  });

  test('Shorter text wins the tiebreak on equal hump-match strength', () => {
    // Both "getUserAccount.ts" and "globalUtilAdapter.ts" spell "gua" via their first
    // three humps, so the tier/compactness bonuses tie; the shorter text wins the tiebreak.
    const a = fuzzyScore('gua', 'getUserAccount.ts');
    const b = fuzzyScore('gua', 'globalUtilAdapter.ts');
    assert.ok(a !== null && b !== null);
    assert.ok((a as number) > (b as number));
  });

  test('fuzzyScore of an empty/whitespace pattern is 0, not null', () => {
    assert.strictEqual(fuzzyScore('', 'anything'), 0);
    assert.strictEqual(fuzzyScore('   ', 'anything'), 0);
  });
});

suite('Configuration Edge Cases', () => {
  test('Default configuration values are correct', () => {
    const config = vscode.workspace.getConfiguration('doubleShiftSearchTabs');
    assert.strictEqual(config.get<boolean>('useSelectionAsQuery'), false);
    assert.strictEqual(config.get<boolean>('rememberLastTab'), true);

    const excludeExtensions = config.get<string[]>('excludeExtensions');
    assert.ok(excludeExtensions?.includes('.zip'));
    assert.ok(excludeExtensions?.includes('.exe'));
    assert.ok(excludeExtensions?.includes('.png'));

    const deprioritizedFolders = config.get<string[]>('deprioritizedFolders');
    assert.ok(deprioritizedFolders?.includes('vendor'));
    assert.ok(deprioritizedFolders?.includes('Pods'));
    assert.ok(deprioritizedFolders?.includes('site-packages'));
  });
});

suite('Staged File Priority Edge Cases', () => {
  test('getStagedFileUris resolves to a Set even without a git repository', async () => {
    const staged = await getStagedFileUris();
    assert.ok(staged instanceof Set);
  });
});

suite('Deprioritized Folder Edge Cases', () => {
  test('getDeprioritizedFolderSet reads the configured defaults', () => {
    const folders = getDeprioritizedFolderSet();
    assert.ok(folders.has('vendor'));
    assert.ok(folders.has('pods')); // Comparisons are case-insensitive
  });

  test('isInDeprioritizedFolder matches any path segment', () => {
    const folders = new Set(['vendor', 'node_modules']);
    assert.strictEqual(isInDeprioritizedFolder('/repo/vendor/lib/pkg.go', folders), true);
    assert.strictEqual(isInDeprioritizedFolder('C:\\repo\\node_modules\\pkg\\index.js', folders), true);
    assert.strictEqual(isInDeprioritizedFolder('/repo/src/pkg.go', folders), false);
  });

  test('isInDeprioritizedFolder is case-insensitive and handles an empty set', () => {
    const folders = new Set(['pods']);
    assert.strictEqual(isInDeprioritizedFolder('/repo/Pods/Alamofire/file.swift', folders), true);
    assert.strictEqual(isInDeprioritizedFolder('/repo/src/file.swift', new Set()), false);
  });
});

suite('File Search Edge Cases', () => {
  test('searchFileContents correctly finds text in files', async () => {
    // Test runs in `out/test/suite/`
    const pkgJsonUri = vscode.Uri.file(path.join(__dirname, '../../../package.json'));

    // Find text that exists
    const results = await searchFileContents('double-shift-search-tabs', [pkgJsonUri], () => false);
    assert.ok(results.length > 0, 'Should find at least one match for the extension name');
    assert.strictEqual(results[0].type, 'text');
  });

  test('searchFileContents respects cancellation token', async () => {
    const pkgJsonUri = vscode.Uri.file(path.join(__dirname, '../../../package.json'));

    // Cancel immediately
    let calledCancel = false;
    const cancelledResults = await searchFileContents('double', [pkgJsonUri], () => {
      calledCancel = true;
      return true; // Simulate cancelled
    });

    assert.strictEqual(cancelledResults.length, 0, 'Should return empty array when cancelled');
    assert.strictEqual(calledCancel, true, 'Cancellation check should be called');
  });

  test('searchFileContents respects maxResults limit', async () => {
    const pkgJsonUri = vscode.Uri.file(path.join(__dirname, '../../../package.json'));

    // Find a common character like "e" with a max limit of 2
    const results = await searchFileContents('e', [pkgJsonUri], () => false, 2);
    assert.ok(results.length <= 2, 'Should not return more results than maxResults');
  });

  test('searchFileContents keeps the match visible when it falls past the snippet cap on a long line', async () => {
    const tmpFile = vscode.Uri.file(path.join(os.tmpdir(), `double-shift-search-tabs-long-line-${Date.now()}.txt`));
    const padding = 'x'.repeat(600);
    const needle = 'NEEDLE_TOKEN';
    await writeFile(tmpFile.fsPath, `${padding}${needle}${padding}`, 'utf8');

    try {
      const results = await searchFileContents(needle, [tmpFile], () => false);
      assert.ok(results.length > 0, 'Should find the match');
      assert.ok(results[0].description?.includes(needle), 'Snippet should include the matched text');
    } finally {
      await unlink(tmpFile.fsPath);
    }
  });

  test('searchFileContents returns one match per line up to maxMatchesPerFile', async () => {
    const tmpFile = vscode.Uri.file(path.join(os.tmpdir(), `double-shift-search-tabs-multi-match-${Date.now()}.txt`));
    await writeFile(tmpFile.fsPath, 'alpha needle needle\nbeta\nneedle gamma\nNEEDLE delta\nneedle', 'utf8');

    try {
      const options = { matchCase: false, wholeWord: false, regex: false, maxMatchesPerFile: 3 };
      const results = await searchFileContents('needle', [tmpFile], () => false, 50, options);
      assert.deepStrictEqual(results.map(r => r.lineNumber), [1, 3, 4]);

      const caseSensitive = await searchFileContents('NEEDLE', [tmpFile], () => false, 50, { ...options, matchCase: true });
      assert.deepStrictEqual(caseSensitive.map(r => r.lineNumber), [4]);

      const firstOnly = await searchFileContents('needle', [tmpFile], () => false);
      assert.deepStrictEqual(firstOnly.map(r => r.lineNumber), [1], 'Default keeps the single first match per file');
    } finally {
      await unlink(tmpFile.fsPath);
    }
  });

  test('searchFileContents rows show file:line, the snippet, the path below and a text icon', async () => {
    const pkgJsonUri = vscode.Uri.file(path.join(__dirname, '../../../package.json'));
    const [result] = await searchFileContents('"publisher"', [pkgJsonUri], () => false);
    assert.ok(result, 'Should find the publisher field');
    assert.match(result.label, /^package\.json:\d+$/);
    assert.ok(result.description?.startsWith('"publisher"'));
    assert.strictEqual(result.detail, vscode.workspace.asRelativePath(pkgJsonUri));
    assert.strictEqual((result.iconPath as vscode.ThemeIcon).id, 'text-size');
  });

  test('searchFileContents returns nothing for an invalid regex instead of throwing', async () => {
    const pkgJsonUri = vscode.Uri.file(path.join(__dirname, '../../../package.json'));
    const options = { matchCase: false, wholeWord: false, regex: true, maxMatchesPerFile: 1 };
    const results = await searchFileContents('(unclosed', [pkgJsonUri], () => false, 50, options);
    assert.strictEqual(results.length, 0);
  });
});

suite('Text Search Regex', () => {
  const plain: TextSearchOptions = { matchCase: false, wholeWord: false, regex: false };

  const regexOf = (query: string, options: TextSearchOptions): RegExp => {
    const built = buildTextSearchRegex(query, options);
    assert.ok('regex' in built, `Expected a valid regex for ${query}`);
    return built.regex;
  };

  test('Literal queries escape regex characters and ignore case by default', () => {
    const regex = regexOf('a.b(c)', plain);
    assert.ok(regex.test('xA.B(C)x'));
    regex.lastIndex = 0;
    assert.ok(!regex.test('aXb(c)'));
  });

  test('Match case is honoured', () => {
    const regex = regexOf('Foo', { ...plain, matchCase: true });
    assert.ok(regex.test('Foo'));
    regex.lastIndex = 0;
    assert.ok(!regex.test('foo'));
  });

  test('Whole word only matches complete words, including non-word edges', () => {
    const word = regexOf('cat', { ...plain, wholeWord: true });
    assert.ok(word.test('the cat sat'));
    word.lastIndex = 0;
    assert.ok(!word.test('concatenate'));
    word.lastIndex = 0;
    assert.ok(!word.test('cat_name'), 'Underscore counts as a word character');
    word.lastIndex = 0;
    assert.ok(word.test('(cat)'));

    const symbol = regexOf('$scope', { ...plain, wholeWord: true });
    assert.ok(symbol.test('use $scope here'));
    symbol.lastIndex = 0;
    assert.ok(!symbol.test('use $scopes here'));
  });

  test('Regex mode is not escaped and combines with whole word and case', () => {
    const regex = regexOf('get\\w+', { matchCase: true, wholeWord: true, regex: true });
    assert.ok(regex.test('x = getUser()'));
    regex.lastIndex = 0;
    assert.ok(!regex.test('x = GetUser()'));
    regex.lastIndex = 0;
    assert.ok(!regex.test('x = forgetUser()'));

    const alternation = regexOf('foo|bar', { ...plain, wholeWord: true, regex: true });
    assert.ok(!alternation.test('foobar'), 'Whole word wraps the whole alternation');
  });

  test('Invalid regex returns an error instead of throwing', () => {
    const built = buildTextSearchRegex('(unclosed', { ...plain, regex: true });
    assert.ok('error' in built);
    assert.ok(built.error.length > 0);

    assert.ok('regex' in buildTextSearchRegex('(unclosed', plain), 'Literal mode escapes the parenthesis');
    assert.strictEqual((built as { error: string }).error, 'Unterminated group');
  });
});

suite('File Mask', () => {
  test('globToRegExp supports * and ? on the whole basename', () => {
    assert.ok(globToRegExp('*.py').test('main.py'));
    assert.ok(!globToRegExp('*.py').test('main.pyc'));
    assert.ok(globToRegExp('file?.ts').test('file1.ts'));
    assert.ok(!globToRegExp('file?.ts').test('file10.ts'));
    assert.ok(globToRegExp('*.TS').test('index.ts'), 'Masks are case-insensitive');
  });

  test('parseFileMask splits includes and ! excludes, ignoring blanks', () => {
    const mask = parseFileMask(' *.py, ,*.vue , !*.test.ts, !');
    assert.strictEqual(mask.include.length, 2);
    assert.strictEqual(mask.exclude.length, 1);
    assert.ok(isFileMaskEmpty(parseFileMask('  ,  ')));
    assert.ok(!isFileMaskEmpty(mask));
  });

  test('matchesFileMask applies includes and negation to the basename', () => {
    const mask = parseFileMask('*.ts, *.vue, !*.test.ts');
    assert.strictEqual(matchesFileMask('/repo/src/app.ts', mask), true);
    assert.strictEqual(matchesFileMask('C:\\repo\\src\\App.vue', mask), true);
    assert.strictEqual(matchesFileMask('/repo/src/app.test.ts', mask), false);
    assert.strictEqual(matchesFileMask('/repo/src/app.py', mask), false);
  });

  test('A mask with only exclusions keeps everything else', () => {
    const mask = parseFileMask('!*.min.js');
    assert.strictEqual(matchesFileMask('/repo/app.js', mask), true);
    assert.strictEqual(matchesFileMask('/repo/app.min.js', mask), false);
  });
});

suite('Search Tabs', () => {
  test('Tabs follow the JetBrains order', () => {
    assert.deepStrictEqual([...SEARCH_TABS], ['all', 'classes', 'files', 'symbols', 'actions', 'text']);
  });

  test('cycleTab moves forward and backward and wraps around', () => {
    assert.strictEqual(cycleTab('all', 1), 'classes');
    assert.strictEqual(cycleTab('actions', 1), 'text');
    assert.strictEqual(cycleTab('text', 1), 'all');
    assert.strictEqual(cycleTab('all', -1), 'text');
    assert.strictEqual(cycleTab('classes', -1), 'all');

    let tab = cycleTab('files', 1);
    for (let i = 1; i < SEARCH_TABS.length; i++) {
      tab = cycleTab(tab, 1);
    }
    assert.strictEqual(tab, 'files', 'A full cycle returns to the starting tab');
  });

});

suite('Result Rows', () => {
  test('getParentPath drops the last segment for either separator', () => {
    assert.strictEqual(getParentPath('src/test/extension.test.ts'), 'src/test');
    assert.strictEqual(getParentPath('C:\\repo\\src\\app.ts'), 'C:\\repo\\src');
    assert.strictEqual(getParentPath('README.md'), '');
  });

  test('getSymbolKindName splits SymbolKind names into words', () => {
    assert.strictEqual(getSymbolKindName(vscode.SymbolKind.Class), 'Class');
    assert.strictEqual(getSymbolKindName(vscode.SymbolKind.TypeParameter), 'Type Parameter');
    assert.strictEqual(getSymbolKindName(vscode.SymbolKind.EnumMember), 'Enum Member');
    assert.strictEqual(getSymbolKindName(999 as vscode.SymbolKind), 'Symbol');
  });

  test('formatSymbolDescription shows kind, container and line', () => {
    assert.strictEqual(formatSymbolDescription(vscode.SymbolKind.Class, '', 12), 'Class · line 12');
    assert.strictEqual(formatSymbolDescription(vscode.SymbolKind.Method, 'UserService', 40), 'Method in UserService · line 40');
  });

  test('getSymbolIconId maps kinds to symbol codicons with a fallback', () => {
    assert.strictEqual(getSymbolIconId(vscode.SymbolKind.Class), 'symbol-class');
    assert.strictEqual(getSymbolIconId(vscode.SymbolKind.Function), 'symbol-method');
    assert.strictEqual(getSymbolIconId(vscode.SymbolKind.Module), 'symbol-namespace');
    assert.strictEqual(getSymbolIconId(vscode.SymbolKind.Constant), 'symbol-misc');
  });
});

suite('Grouped Results', () => {
  const row = (label: string): SearchItem => ({ label, type: 'file' });
  const status: SearchItem = { label: '$(sync~spin) Searching...', type: 'action' };
  const shape = (items: SearchItem[]) =>
    items.map(item => item.kind === vscode.QuickPickItemKind.Separator ? `--${item.label}--` : item.label);

  test('buildGroupedItems puts a header before each non-empty group, in order', () => {
    const items = buildGroupedItems([
      { label: 'Recent', items: [row('a.ts')] },
      { label: 'Folders', items: [] },
      { label: 'Files', items: [row('b.ts'), row('c.ts')] }
    ]);
    assert.deepStrictEqual(shape(items), ['--Recent--', 'a.ts', '--Files--', 'b.ts', 'c.ts']);
    assert.ok(items.filter(item => item.kind === vscode.QuickPickItemKind.Separator).every(item => item.type === 'separator'));
  });

  test('buildGroupedItems returns nothing when every group is empty', () => {
    assert.deepStrictEqual(buildGroupedItems([{ label: 'Files', items: [] }, { label: '', items: [] }]), []);
  });

  test('Unlabelled status groups get a plain divider, and none when they come first', () => {
    assert.deepStrictEqual(
      shape(buildGroupedItems([{ label: 'Files', items: [row('a.ts')] }, { label: '', items: [status] }])),
      ['--Files--', 'a.ts', '----', status.label]
    );
    assert.deepStrictEqual(shape(buildGroupedItems([{ label: 'Files', items: [] }, { label: '', items: [status] }])), [status.label]);
  });
});

suite('Contributed Commands', () => {
  test('collectContributedCommands builds "Category: Title", dedupes and sorts', () => {
    const commands = collectContributedCommands([
      { contributes: { commands: [
        { command: 'git.commit', title: 'Commit', category: 'Git' },
        { command: 'git.push', title: 'Push', category: 'Git' }
      ] } },
      { contributes: { commands: { command: 'other.single', title: 'Another Command' } } },
      { contributes: { commands: [{ command: 'git.commit', title: 'Duplicate', category: 'Dup' }] } },
      { name: 'no-contributes' },
      undefined
    ]);
    assert.deepStrictEqual(commands, [
      { id: 'other.single', title: 'Another Command' },
      { id: 'git.commit', title: 'Git: Commit' },
      { id: 'git.push', title: 'Git: Push' }
    ]);
  });

  test('collectContributedCommands handles localized titles and hidden commands', () => {
    const commands = collectContributedCommands([
      { contributes: {
        commands: [
          { command: 'ext.localized', title: { value: 'Localized', original: 'Localized' }, category: '%ext.category%' },
          { command: 'ext.placeholder', title: '%ext.title%' },
          { command: 'ext.hidden', title: 'Hidden' },
          { title: 'Missing id' }
        ],
        menus: { commandPalette: [{ command: 'ext.hidden', when: 'false' }, { command: 'ext.localized', when: 'editorFocus' }] }
      } }
    ]);
    assert.deepStrictEqual(commands, [
      { id: 'ext.placeholder', title: 'ext.placeholder' },
      { id: 'ext.localized', title: 'Localized' }
    ]);
  });
});

suite('Workspace File Excludes', () => {
  test('expandBraces flattens brace groups, including nested ones', () => {
    assert.deepStrictEqual(expandBraces('**/node_modules'), ['**/node_modules']);
    assert.deepStrictEqual(expandBraces('**/{bin,obj}'), ['**/bin', '**/obj']);
    assert.deepStrictEqual(expandBraces('**/*.{js,{map,d.ts}}'), ['**/*.js', '**/*.map', '**/*.d.ts']);
    assert.deepStrictEqual(expandBraces('**/{broken'), ['**/{broken']);
  });

  test('buildExcludeGlob merges patterns into a single glob', () => {
    assert.strictEqual(buildExcludeGlob([]), undefined);
    assert.strictEqual(buildExcludeGlob(['**/node_modules']), '**/node_modules');
    assert.strictEqual(buildExcludeGlob(['**/node_modules', '**/bin']), '{**/node_modules,**/bin}');
  });

  test('getExcludePatterns includes the default search.exclude and files.exclude entries', () => {
    const patterns = getExcludePatterns();
    assert.ok(patterns.includes('**/node_modules'), 'search.exclude default should be included');
    assert.ok(patterns.includes('**/.git'), 'files.exclude default should be included');
  });

  test('getExcludePatterns includes the built-in folder list by default', () => {
    const patterns = getExcludePatterns();
    for (const folder of DEFAULT_EXCLUDED_FOLDERS) {
      assert.ok(patterns.includes(`**/${folder}`), `missing **/${folder}`);
    }
  });

  test('getExcludedFolderNames picks out plain folder patterns for the watcher', () => {
    const names = getExcludedFolderNames(['**/node_modules', '**/bin/**', '**/*.code-search', 'src/generated']);
    assert.ok(names.has('node_modules'));
    assert.ok(names.has('bin'));
    assert.ok(names.has('.git'));
    assert.ok(!names.has('*.code-search'));
    assert.ok(!names.has('generated'));
  });

  test('toUnbreakableTitle leaves no line-break opportunities', () => {
    const title = toUnbreakableTitle('Search Everywhere - All');
    assert.ok(title.startsWith('Search\u00a0Everywhere\u00a0\u2011\u00a0All'));
    assert.ok(!/[ -]/.test(title));
  });
});

