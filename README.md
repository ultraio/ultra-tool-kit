# Ultra Tool Kit

## Intro

Ultra Tool Kit allows you to interact with Ultra Blockchain through your browser and allows you to query information directly from the Blockchain or use Ultra API to get additional data.

## Features

-   Connect to Ultra Testnet and Ultra Mainnet or a custom network
    - Supports [Ultra Wallet](https://developers.ultra.io/products/ultra-wallet/), Ledger and Anchor Wallet
-   Build and execute transactions with any smart contract
-   Create, approve and execute proposals
-   Query [Ultra API](https://developers.ultra.io/products/nft-api/introduction.html)
-   Validate Uniq and Factory Metadata JSONs

## How to use

We provide a deployed version of this Web application at https://toolkit.ultra.io/. You don't need to build and install it locally.

For additional details refer to the [official documentation](https://developers.ultra.io/tutorials/fundamentals/tutorial-login-to-toolkit.html)

## Contribution Standards

- For styling we use Tailwind CSS so it is strongly advised to use it for any stylization of the components.

- All components added or modified belong to `src/components`. Reusable components that are used in multiple contexts or are not useable on their own belong to `src/components/widgets`.
  - To use your component you also need to register it in `src/main.ts`

- Every individual page should be geared towards a specific use case and should be placed in `src/pages` under a dedicated directory for a specific page (e.g. `src/pages/schemaValidator`).

- Use Prettier VS Code extension during development to ensure uniform formatting.

- If you decide to create a Pull Request, please assign `ultraio/blockchain-fireman` as a reviewer and/or let us know in `dev-general` channel of our Discord server.

- There is no strict rules about what your custom component or page should be addressing, any creative ideas or fixes are welcome. In most cases, the functionality should be related to Ultra and/or EOS Blockchains.

## How to build and run locally

To use this tool locally you will need a Node 16+ installed on your system. [NVM](https://github.com/nvm-sh/nvm) or [NVM for Windows](https://github.com/coreybutler/nvm-windows) are strongly suggested for Node installation.

Clone this repo to the desired directory or download the source from Github and unpack it.

Within the repository directory perform the following command to install the dependencies:

```
npm install
```

Finally, to run the tool locally do this:

```
npm run dev
```

You will be provided with a URL to use to connect to the Ultra Tool Kit using your browser (e.g. https://localhost:5173/).

## Suggested Extensions for Developers

Install these extensions for a faster development experience.

- [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)
  - Used to provide better auto-completion for Vue files.

## Code structure

- `App.vue` controls the initial flow of the application. We only use it to initialize some of the states required throughout the Tool Kit and to prepare a scaffold where the main page content will be loaded through `router-view`.
- Based on the selected page in the sidebar, the content of the page is populated using the associated `index.vue` file from `src/pages`.
- Some common logic is placed under `src/utilities` and is used between multiple components and pages.
- To communicate data from parent component to child component, we use component properties (e.g. `<Link :link="transactionLink" />`).
- To communicate data from child component to parent component, we use signals. Example:

```ts
// Child component AuthorizerForm
function updateAuthorizers() {
    emits('set-authorizer', ...);
}

// Parent component
<AuthorizerForm
    ...
    @set-authorizer="setAuthorizer"
/>

function setAuthorizer(...) {
    ...
}
```

- To re-render a component after internal data modifications that do not cause a refresh on their own, we use the `key` property which is incremented each time some modification occurs:

```ts
<UserOverlay
    ...
    :key="keyUserUpdate"
/>

async function setEndpoint(...) {
    ...
    keyUserUpdate.value += 1;
}
```

- To add new icons from `fontawesome`, it is required to modify `src/icons.ts` to add a new icon to the list in `library.add(`.
