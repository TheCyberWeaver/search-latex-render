# Publishing

This repository is prepared for Obsidian community plugin submission.

## Release checklist

Before creating a GitHub release, make sure the repository root contains:

- `README.md`
- `LICENSE`
- `manifest.json`
- `versions.json`

## Create a release

1. Push this repository to a public GitHub repository.
2. Confirm the plugin folder name, plugin `id`, and release assets all use `search-latex-render`.
3. Update `manifest.json` `version` using semantic versioning.
4. If `minAppVersion` changes, update `versions.json`.
5. Build the plugin:

```bash
npm install
npm test
npm run build
```

6. Create a GitHub release whose tag exactly matches `manifest.json` `version`.
7. Attach these release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`

## Submit to the community plugin list

1. Fork `obsidianmd/obsidian-releases`.
2. Add an entry to `community-plugins.json`:

```json
{
  "id": "search-latex-render",
  "name": "Search Latex Render",
  "author": "Thomas Lu",
  "description": "Render full LaTeX expressions inside Obsidian search results, including recovered partial snippets.",
  "repo": "<your-github-user-or-org>/<your-repo-name>"
}
```

3. Open a pull request titled `Add plugin: Search Latex Render`.
4. Complete the Community Plugin PR template and wait for validation/review.

## Notes

- `main.js` is ignored in git and should be uploaded as a release asset, not committed.
- Rebuild and replace the GitHub release assets if review feedback requires code changes.
