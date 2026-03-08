# Search Latex Render

Render LaTeX directly inside Obsidian's built-in Search results.

This plugin detects inline math (`$...$`) and block math (`$$...$$`) in search hits, and tries to recover the full expression from the source note when Obsidian only shows a truncated fragment.

Built from the official [`obsidianmd/obsidian-sample-plugin`](https://github.com/obsidianmd/obsidian-sample-plugin) template.

## What it does

- Renders inline math in Search results.
- Renders block math in Search results.
- Recovers partial formulas from the source file using the result line number.
- Avoids common false positives such as currency text like `$10` or `$1亿`.

## How it works

When a search result contains math-like text, the plugin:

1. Locates the source note for that search hit.
2. Uses the displayed line number to load the original line or block from the note.
3. Reconstructs the complete LaTeX expression when the visible snippet is incomplete.
4. Renders only the math spans back into the Search result UI.

## Settings

- `Enable search math rendering`: Turn rendering on or off.
- `Debounce`: Delay before processing changed search results.
- `Context characters`: Extra text to keep around recovered inline math.
- `Max rendered line length`: Limit for very long source lines.
- `Max block length`: Skip very large recovered block formulas.

## Manual installation

Copy these files into your vault under `.obsidian/plugins/search-latex-render/`:

- `main.js`
- `manifest.json`
- `styles.css`

Then reload Obsidian and enable `Search Latex Render` in Community plugins.

## Development

```bash
npm install
npm test
npm run build
```

## Security and privacy

- No network requests.
- No telemetry.
- Reads note content from the current vault only to reconstruct full math expressions for Search results.
- Does not modify note files.

## Compatibility

- Minimum app version: `1.5.0`

## License

MIT
