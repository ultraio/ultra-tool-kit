# Ultra Tool Kit

Provides a template to begin writing other toolkits for web distribution.

Includes plenty of `blockchain` related functionality.

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

All components belong in components.

`App.vue` should only control the initial flow of the application.

Every individual page should be geared towards a specific use case.

This library specifically provides utilities / components for other toolkits.

## Development

Node 16+

```
npm install
```

```
npm run dev
```

## Suggested Extensions for Developers

Install these extensions for a faster development experience.

- [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)
  - Used to provide better auto-completion for Vue files. 