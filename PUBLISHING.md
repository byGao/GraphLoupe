# Publishing GraphLoupe

The steps that need an account or credentials — you run these, not any automation. Everything
else (icon, version, README, docs site, packaging) is already prepared in the repo.

## 0. Prerequisites

- Node 18+ and this repo installed: `npm install`
- `vsce` is available via `npx @vscode/vsce` (already a devDependency)
- Version is set in `package.json` (currently **0.3.0**). Bump it before each publish.
  Marketplace versions must be `major.minor.patch` integers — **no `-beta` suffix**. For a
  "beta", publish with `--pre-release` (below), keeping a normal `x.y.z` version.

## 1. Create a Marketplace publisher (once)

Sign in with a Microsoft account and create a publisher whose ID matches `publisher` in
`package.json` (**`byGao`**):

- Publisher management → https://marketplace.visualstudio.com/manage
- Official guide (authoritative) → https://code.visualstudio.com/api/working-with-extensions/publishing-extension

## 2. Create a Personal Access Token (PAT)

In Azure DevOps (same Microsoft account):

1. https://dev.azure.com/  → sign in
2. Top-right avatar → **Personal access tokens** → **+ New Token**
3. **Organization**: `All accessible organizations`
4. **Scopes**: expand to find **Marketplace** → check **Manage**
5. **Create** → copy the token (shown once)

## 3. Package + verify (optional local check)

```bash
npm run package          # -> graphloupe-0.3.0.vsix
npx @vscode/vsce ls      # confirm contents: dist/, graphloupe_sidecar/*.py, protocol.py,
                         # requirements.lock, media/icon.png, README.md, LICENSE  (no tests/src)
```

## 4. Publish

```bash
npx @vscode/vsce login byGao      # paste the PAT
npx @vscode/vsce publish          # publishes package.json's version

# For a pre-release channel instead (a "Pre-Release" badge, opt-in for users):
npx @vscode/vsce publish --pre-release
```

The listing appears at `https://marketplace.visualstudio.com/items?itemName=byGao.graphloupe`.

## 5. Enable the documentation site (GitHub Pages)

The full docs live in `docs/index.html`. Turn on Pages once:

- Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, folder: **/docs**
- The site publishes at **https://bygao.github.io/GraphLoupe/** (linked from the README).

## 6. Get discovered

Submit a PR adding GraphLoupe to **awesome-langgraph** (link the Marketplace listing + the docs
site + the manual-inference differentiator). Do this once the Marketplace listing is live so the
"Install" link is one click.

---

**Notes**

- Re-publishing requires a new version number each time (`npm version patch|minor`).
- The README's images (`docs/img/*.png`) ship in the vsix so the Marketplace page renders them.
- `docs/index.html` (the Pages site) and this file are excluded from the vsix (see `.vscodeignore`).
