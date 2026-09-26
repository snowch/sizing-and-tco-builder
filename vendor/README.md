# Vendored code

Copied from `node_modules` so the site runs as static files with no build step and no network.

| Directory | Package | Version | Licence |
|---|---|---|---|
| `yaml/` | [`yaml`](https://eemeli.org/yaml/) (`browser/dist`) | 2.9.1, pinned in `package.json` | ISC (`yaml/LICENSE`) |

To update: change the version in `package.json`, `npm install`, then copy
`node_modules/yaml/browser/dist` to `vendor/yaml` and its `LICENSE` beside it.
`test/vendor.test.js` fails if the copy differs from the installed package.
