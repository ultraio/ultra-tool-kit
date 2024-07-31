import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { ABI, LoginResult, Session, SessionKit, TransactABIDef, Action as WharfkitAction } from '@wharfkit/session';
import { Action } from '../interfaces';
import { fetchWithTimeout } from '../utilities/networks';

const ui = new WebRenderer();
const anchor = new WalletPluginAnchor();

let sessionKit: SessionKit;
let session: Session;

export async function getChainIdentifier(url): Promise<string | undefined> {
    const options = { method: 'GET', headers: { 'Content-Type': 'application/json' } };

    const response = await fetchWithTimeout(`${url}/v1/chain/get_info`, options).catch((err) => {
        console.error(err);
        return undefined;
    });

    if (!response || !response.ok) {
        return undefined;
    }

    const chain_info: { chain_id: string } = await response.json();
    return chain_info.chain_id;
}

export async function connect(url: string): Promise<{ blockchainid: string; permission: string } | undefined> {
    const id = await getChainIdentifier(url);

    sessionKit = new SessionKit({
        appName: 'Ultra Tool Kit',
        chains: [{ id, url }],
        ui,
        walletPlugins: [anchor],
    });

    const loginResult: LoginResult = await sessionKit.login().catch((err) => {
        console.error(err);
        return undefined;
    });

    if (!loginResult) {
        return undefined;
    }

    session = loginResult.session;

    return {
        blockchainid: session.actor.toString(),
        permission: loginResult.session.permission.toString(),
    };
}

/**
 * Convert actions to Wharfkit Compatible Actions
 *
 * @export
 * @param {Action[]} actions
 * @param {string} actor
 * @param {string} permission
 * @return {WharfkitAction[]}
 */
export async function convertActions(
    actions: Action[],
    actor: string,
    permission: string
): Promise<{ actions: WharfkitAction[] }> {
    const wharfkitActions: WharfkitAction[] = [];

    for (let action of actions) {
        const abi = await session.client.v1.chain.get_abi(action.contract);
        wharfkitActions.push(
            WharfkitAction.from(
                {
                    account: action.contract,
                    name: action.action,
                    authorization: action.authorization
                        ? action.authorization
                        : [
                              {
                                  actor,
                                  permission: permission ? permission : 'active',
                              },
                          ],
                    data: action.data,
                },
                abi.abi
            )
        );
    }

    return { actions: wharfkitActions };
}

export async function restore(url: string) {
    const id = await getChainIdentifier(url);

    sessionKit = new SessionKit({
        appName: 'Ultra Tool Kit',
        chains: [{ id, url }],
        ui,
        walletPlugins: [anchor],
    });

    session = await sessionKit.restore({ chain: id });
    console.log(`Restored Anchor Wallet Session`);
}

export async function logout() {
    if (!session) {
        return;
    }

    sessionKit.logout(session);
}

export function getSession(): Session {
    return session;
}
