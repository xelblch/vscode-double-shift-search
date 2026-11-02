# Title bar icons

Generated from [Codicons](https://github.com/microsoft/vscode-codicons) 0.0.46 by Microsoft, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Each glyph keeps its native 16px size and is recoloured; the
`-active` variants add a borderless rounded background in the Modern themes' `inputOption.activeBackground` colour,
so VS Code's own hover highlight is the only outline. The `-active` files are 20px with a 2px margin around the
16px glyph: VS Code draws title button icons at their own size inside a 20px button, so the background fills
the button's padding and the glyph keeps its full size.

Files are named `<codicon>-<active|off>-<light|dark>.svg`.

VS Code caches these images by path, even across window reloads. When an icon's look changes, give the files
new names (as the `-on` to `-active` rename did), or the old images keep showing.
