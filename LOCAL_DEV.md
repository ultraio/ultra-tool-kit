# Local development notes

## Local `@ultraos/wallet-sdk` (when `@ultraos/wallet-sdk@0.4.0`+ isn't on the registry yet)

Wave **W9** (wallet-native attestation) consumes the `ConnectAttestation` type and
the `ConnectResult.attestation` field from `@ultraos/wallet-sdk@0.4.0`. As of this
writing the registry's latest published version is **0.3.1**, so the toolkit links
the SDK from a local build of the wallet monorepo. `package.json` deliberately stays
at the **registry-resolvable range** (`^0.3.1`) — the symlink lives in
`node_modules/` only and is never committed.

### Link it (Path B — pre-publish)

```bash
# 1. Build the SDK in the wallet monorepo (the build artifact lands in dist/).
(cd ~/ultra/web-app && npx nx build wallet-sdk)
ls ~/ultra/web-app/dist/libs/wallet-sdk        # confirm output (package.json shows 0.4.0)

# 2. Register the global link from the built package, then link it into the toolkit.
(cd ~/ultra/web-app/dist/libs/wallet-sdk && npm link)
cd /path/to/ultra-tool-kit && npm link @ultraos/wallet-sdk

# 3. Confirm the resolved version.
node -e "console.log(require('@ultraos/wallet-sdk/package.json').version)"   # => 0.4.0
```

`node_modules/@ultraos/wallet-sdk` is now a symlink to the monorepo build. `npm run
build` (vue-tsc) resolves the W9 attestation types from it.

### What is and isn't committed

- **Not committed:** the `node_modules/@ultraos/wallet-sdk` symlink (per-developer),
  and any `package.json` / `package-lock.json` change that would pin a `file:` path.
  Never commit a `file:` dependency for the SDK — that bakes in a machine-specific
  path. Always use `npm link` for local-source consumption.
- **Committed:** the W9 source that consumes the new type (`src/wallets/**`,
  `src/utilities/aiClient.ts`, `src/composables/useAiChat.ts`).

### Switch to the published version (Path A — once 0.4.0+ ships)

```bash
npm unlink @ultraos/wallet-sdk      # drop the local symlink
# bump "@ultraos/wallet-sdk" to "^0.4.0" in package.json, then:
npm install                          # resolves from the registry; commit the lockfile change
```

CI and fresh clones use Path A. Until 0.4.0 is published, a clean `npm ci` will
resolve `^0.3.1` (which lacks the attestation types) — expected; the local link is
the documented developer workaround for the W9 wave window.
