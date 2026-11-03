# Development

```bash
npm install
npm run compile                # type-check and bundle to dist/
npm run watch                  # rebuild on changes
npm run lint
npm test                       # runs the suite inside a downloaded VS Code
npx @vscode/vsce package       # build the .vsix
code --install-extension double-shift-search-tabs-1.0.0.vsix
```

Press `F5` in VS Code to try changes in an Extension Development Host. CI runs the tests and builds the
`.vsix` on every push and pull request.

The Marketplace page is `README.md`, so keep it about using the extension; build and release notes belong here.
