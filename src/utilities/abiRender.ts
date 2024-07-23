import * as I from '../interfaces/index';

const isTest = false;

// TODO: fetch URI from on-chain contract table
export async function getContractDescriptor(contract: string): Promise<I.SmartContractMetadata> {
    if (contract == 'eosio.nft.ft' && isTest) {
        return getNftContractDescriptorTest();
    }
    
    const options = {
        method: 'GET',
    };
    const response = await fetch(
        `https://raw.githubusercontent.com/ultraio/docs-blockchain/main/descriptors/${contract}-descriptor.json`,
        options
    );
    if (!response || !response.ok) {
        console.log(`failed to get contract descriptor for ${contract}`);
        return undefined;
    }
    try {
        const data = await response.json();
        return data;
    } catch (err) {
        console.error(err);
        return undefined;
    }
}

export function getNftContractDescriptorTest(): I.SmartContractMetadata {
    return {
        "actions": {
            "mknftofr.a": {
                "friendlyName": "Make Uniq Offer",
                "description": "Anyone can make an offer on a Uniq",
                "fields": {
                    "buyer": {
                        "friendlyName": "Buyer",
                        "description": "The account making the offer"
                    },
                    "receiver": {
                        "friendlyName": "Receiver",
                        "description": "The account to receive the Uniq (optional)"
                    },
                    "price": {
                        "friendlyName": "Price",
                        "description": "Offer price"
                    },
                    "promoter_basis_point": {
                        "friendlyName": "Promoter Basis Points",
                        "description": "Promoter commission in basis points"
                    },
                    "owner": {
                        "friendlyName": "Owner",
                        "description": "The owner of the Uniq"
                    },
                    "nft_id": {
                        "friendlyName": "Uniq ID",
                        "description": "The ID of the Uniq"
                    },
                    "duration": {
                        "friendlyName": "Duration",
                        "description": "The duration of the offer in seconds"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "acptnftofr.a": {
                "friendlyName": "Accept Uniq Offer",
                "description": "Only the Uniq owner can accept an offer",
                "fields": {
                    "owner": {
                        "friendlyName": "Owner",
                        "description": "The owner of the Uniq"
                    },
                    "nft_id": {
                        "friendlyName": "Uniq ID",
                        "description": "The ID of the Uniq"
                    },
                    "offer_id": {
                        "friendlyName": "Offer ID",
                        "description": "The ID of the offer being accepted"
                    },
                    "promoter_id": {
                        "friendlyName": "Promoter ID",
                        "description": "The promoter account (optional)"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "rmnftofr.a": {
                "friendlyName": "Cancel Uniq Offer",
                "description": "The buyer can cancel their offer, unless it is expired",
                "fields": {
                    "canceler": {
                        "friendlyName": "Canceler",
                        "description": "The account canceling the offer"
                    },
                    "nft_id": {
                        "friendlyName": "Uniq ID",
                        "description": "The ID of the Uniq"
                    },
                    "offer_id": {
                        "friendlyName": "Offer ID",
                        "description": "The ID of the offer being canceled"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "mkfctofr.a": {
                "friendlyName": "Make Factory Offer",
                "description": "Make a uniq offer on a given factory.",
                "fields": {
                    "buyer": {
                        "friendlyName": "Buyer",
                        "description": "The buyer account"
                    },
                    "receiver": {
                        "friendlyName": "Receiver",
                        "description": "The receiver account (optional)"
                    },
                    "price": {
                        "friendlyName": "Price",
                        "description": "Offer price"
                    },
                    "promoter_basis_point": {
                        "friendlyName": "Promoter Basis Points",
                        "description": "Promoter commission in basis points"
                    },
                    "factory_id": {
                        "friendlyName": "Token Factory ID",
                        "description": "The issuing token factory ID"
                    },
                    "duration": {
                        "friendlyName": "Duration",
                        "description": "The offer duration in seconds"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "The memo string to accompany the transaction"
                    }
                }
            },
            "acptfctofr.a": {
                "friendlyName": "Accept Factory Offer",
                "description": "Accept the uniq offer made on the factory.",
                "fields": {
                    "owner": {
                        "friendlyName": "Owner",
                        "description": "The token owner account"
                    },
                    "nft_id": {
                        "friendlyName": "Token ID",
                        "description": "The token ID"
                    },
                    "offer_id": {
                        "friendlyName": "Offer ID",
                        "description": "The offer ID made on the factory"
                    },
                    "promoter_id": {
                        "friendlyName": "Promoter ID",
                        "description": "The promoter account (optional)"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "The memo string to accompany the transaction"
                    }
                }
            },
            "rmfctofr.a": {
                "friendlyName": "Cancel Factory Offer",
                "description": "Cancel the token uniq offer made on the factory.",
                "fields": {
                    "canceler": {
                        "friendlyName": "Canceler",
                        "description": "The account who cancels the offer"
                    },
                    "factory_id": {
                        "friendlyName": "Token Factory ID",
                        "description": "The token factory ID"
                    },
                    "offer_id": {
                        "friendlyName": "Offer ID",
                        "description": "The offer ID made on the facotry"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "The memo string to accompany the transaction"
                    }
                }
            },
            "authmint.b": {
                "friendlyName": "Authorize minter",
                "description": "Authorize an account to be able to mint tokens",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/authmint.b.html",
                "fields": {
                    "authorizer": {
                        "friendlyName": "Authorizer",
                        "description": "The account that authorizes"
                    },
                    "authorized_minter": {
                        "friendlyName": "Authorized minter",
                        "description": "The account being authorized to mint tokens"
                    },
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "The issuing token factory ID"
                    },
                    "quantity": {
                        "friendlyName": "Quantity",
                        "description": "The number of tokens being authorized"
                    },
                    "maximum_uos_payment": {
                        "friendlyName": "Maximum UOS payment",
                        "description": "Maximum amount of UOS that is allowed to be used for the purposes of contract RAM usage"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "clrmintst": {
                "friendlyName": "Clear minting status",
                "description": "Clears (i.e., deletes the rows of) minting status table of a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/clrmintst.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "The token factory ID"
                    },
                    "no_of_entries": {
                        "friendlyName": "Num of entries",
                        "description": "Optional, the number of entries to delete from the token_factory's mintstat table. If no_of_entries is not specified (i.e., null), all entries are deleted"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "create.b": {
                "friendlyName": "Create token factory",
                "description": "Create a new token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/create.b.html",
                "fields": {
                    "create": {
                        "friendlyName": "create wrapper",
                        "fields": {
                            "to": {
                                "friendlyName": "To",
                                "description": "Receiver of the minted token"
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            },
                            "asset_creator": {
                                "friendlyName": "Asset creator",
                                "description": "Token factory creator"
                            },
                            "asset_manager": {
                                "friendlyName": "Asset manager",
                                "description": "Token factory manager"
                            },
                            "minimum_resell_price": {
                                "friendlyName": "Minimum resell price",
                                "description": "Optional, the minimum resale price for the uniqs of this factory"
                            },
                            "resale_shares": {
                                "friendlyName": "Resale shares",
                                "description": "Optional, the resale share(s) configuration",
                                "fields": {
                                    "receiver": {
                                        "friendlyName": "Receiver",
                                        "description": "Resale share receiver account"
                                    },
                                    "basis_point": {
                                        "friendlyName": "Basis points",
                                        "description": "Resale share commission"
                                    }
                                }
                            },
                            "mintable_window_start": {
                                "friendlyName": "Mintable window start",
                                "description": "Optional, the starting date for minting window"
                            },
                            "mintable_window_end": {
                                "friendlyName": "Mintable window end",
                                "description": "Optional, the ending date for minting window"
                            },
                            "trading_window_start": {
                                "friendlyName": "Trading window start",
                                "description": "Optional, the starting date for minting window"
                            },
                            "trading_window_end": {
                                "friendlyName": "Trading window end",
                                "description": "Optional, the ending date for minting window"
                            },
                            "recall_window_start": {
                                "friendlyName": "Recall window start",
                                "description": "Deprecated, use null"
                            },
                            "recall_window_end": {
                                "friendlyName": "Recall window end",
                                "description": "Deprecated, use null"
                            },
                            "max_mintable_tokens": {
                                "friendlyName": "Max mintable tokens",
                                "description": "Optional, max number of tokens in this factory. Null means an unlimited number of tokens"
                            },
                            "lockup_time": {
                                "friendlyName": "Lockup time",
                                "description": "Deprecated, use null"
                            },
                            "conditionless_receivers": {
                                "friendlyName": "Conditionless receivers",
                                "description": "Optional, list of accounts that can receive tokens without meeting transfer conditions",
                                "fields": {
                                    "name": {
                                        "friendlyName": "Conditionless receiver",
                                        "description": "Conditionless receiver account"
                                    }
                                }
                            },
                            "stat": {
                                "friendlyName": "Stat",
                                "description": "Optional, factory status. Use null for default"
                            },
                            "factory_uri": {
                                "friendlyName": "Metadata URI",
                                "description": "Factory metadata URI"
                            },
                            "factory_hash": {
                                "friendlyName": "Metadata hash",
                                "description": "Optional, factory metadata hash"
                            },
                            "authorized_minters": {
                                "friendlyName": "Authorized minters",
                                "description": "Optional, accounts authorized to mint tokens from the factory",
                                "fields": {
                                    "authorized_minter": {
                                        "friendlyName": "Authorized Minter",
                                        "description": "The account being authorized to mint"
                                    },
                                    "quantity": {
                                        "friendlyName": "Quantity",
                                        "description": "Quantity that the authorized account can mint"
                                    }
                                }
                            },
                            "account_minting_limit": {
                                "friendlyName": "Account minting limit",
                                "description": "Max number of tokens an account can mint. Set to null to allow for unlimited tokens per account"
                            },
                            "transfer_window_start": {
                                "friendlyName": "Transfer window start",
                                "description": "Optional, the starting date for transfer window"
                            },
                            "transfer_window_end": {
                                "friendlyName": "Transfer window end",
                                "description": "Optional, the ending date for transfer window"
                            },
                            "default_token_uri": {
                                "friendlyName": "Default token URI",
                                "description": "URI pointing to the token metadata if there is no token-specific metadata"
                            },
                            "default_token_hash": {
                                "friendlyName": "Default token hash",
                                "description": "Optional, hash of static default token metadata"
                            },
                            "lock_hash": {
                                "friendlyName": "Lock hash",
                                "description": "Optional, whether to prevent changes to the hashes provided during the factory creation. Defaults to false"
                            },
                            "maximum_uos_payment": {
                                "friendlyName": "Maximum UOS payment",
                                "description": "Maximum amount of UOS that is allowed to be used for the purposes of contract RAM usage"
                            }
                        }
                    }
                }
            },
            "issue.b": {
                "friendlyName": "Issue tokens",
                "description": "Issue tokens from the factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/issue.b.html",
                "fields": {
                    "issue": {
                        "friendlyName": "Issue wrapper",
                        "fields": {
                            "to": {
                                "friendlyName": "To",
                                "description": "Receiver of the minted token"
                            },
                            "token_configs": {
                                "friendlyName": "Token configs",
                                "description": "List of factories to issue tokens from",
                                "fields": {
                                    "token_factory_id": {
                                        "friendlyName": "Token factory ID",
                                        "description": "ID of the factory from which the tokens should be minted"
                                    },
                                    "amount": {
                                        "friendlyName": "Amount",
                                        "description": "Number of tokens to be minted"
                                    },
                                    "custom_data": {
                                        "friendlyName": "Custom data",
                                        "description": "Currently unused"
                                    }
                                }
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            },
                            "authorizer": {
                                "friendlyName": "Authorizer",
                                "description": "Optional authorizer of the mint. Must be one of authorized minters of the factory"
                            },
                            "maximum_uos_payment": {
                                "friendlyName": "Maximum UOS payment",
                                "description": "Maximum amount of UOS that is allowed to be used for the purposes of contract RAM usage"
                            },
                            "token_metadata": {
                                "friendlyName": "Token metadata",
                                "description": "Optional metadata to be added to the minted tokens",
                                "fields": {
                                    "meta_uri": {
                                        "friendlyName": "Metadata URI",
                                        "description": "URI of the token metadata"
                                    },
                                    "meta_hash": {
                                        "friendlyName": "Metadata hash",
                                        "description": "Hash of the token metadata"
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "lckfactory": {
                "friendlyName": "Lock factory",
                "description": "Allows a factory manager to lock hashes for the factory, default token and all minted tokens as well as any token minted afterwards",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/lckfactory.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    }
                }
            },
            "limitmint": {
                "friendlyName": "Set minting limit",
                "description": "Sets/Resets the minting limit per account of a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/limitmint.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "account_minting_limit": {
                        "friendlyName": "Account minting limit",
                        "description": "Max number of tokens an account can mint"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "setconrecv": {
                "friendlyName": "Set conditionless receivers",
                "description": "Set accounts that can receive tokens without meeting transfer conditions",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/setconrecv.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    },
                    "conditionless_receivers": {
                        "friendlyName": "Conditionless receivers",
                        "description": "List of accounts that can receive tokens without meeting transfer conditions",
                        "fields": {
                            "name": {
                                "friendlyName": "Conditionless receiver",
                                "description": "Conditionless receiver account"
                            }
                        }
                    }
                }
            },
            "setdflttkn": {
                "friendlyName": "Set default token metadata",
                "description": "Set metadata URI and hash for default token of a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/setdflttkn.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "uri": {
                        "friendlyName": "Metadata URI",
                        "description": "URI of the default token metadata"
                    },
                    "hash": {
                        "friendlyName": "Metadata hash",
                        "description": "Hash of the default token metadata"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "setmeta.b": {
                "friendlyName": "Set factory metadata",
                "description": "Set metadata uri and hash for a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/setmeta.b.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "factory_uri": {
                        "friendlyName": "Metadata URI",
                        "description": "URI of the factory metadata"
                    },
                    "factory_hash": {
                        "friendlyName": "Metadata hash",
                        "description": "Hash of the factory metadata"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "setstatus": {
                "friendlyName": "Set factory state",
                "description": "Set token factory state",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/setstatus.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "status": {
                        "friendlyName": "Status",
                        "description": "State of the factory (0 = Active, 1 = Inactive, 2 = Shutdown)"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "settknmeta": {
                "friendlyName": "Set token metadata",
                "description": "Set metadata uri and hash for a uniq",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/settknmeta.html",
                "fields": {
                    "token_id": {
                        "friendlyName": "Token ID",
                        "description": "ID of the token"
                    },
                    "owner": {
                        "friendlyName": "Owner",
                        "description": "Owner of the token"
                    },
                    "uri": {
                        "friendlyName": "Metadata URI",
                        "description": "URI of the token metadata"
                    },
                    "hash": {
                        "friendlyName": "Metadata hash",
                        "description": "Hash of the token metadata"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "settrdwin.a": {
                "friendlyName": "Set trading window",
                "description": "Set the trading window for a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/settrdwin.a.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "trading_window_start": {
                        "friendlyName": "Trading window start",
                        "description": "Optional, the starting date for minting window"
                    },
                    "trading_window_end": {
                        "friendlyName": "Trading window end",
                        "description": "Optional, the ending date for minting window"
                    }
                }
            },
            "settrnfwin.a": {
                "friendlyName": "Set transfer window",
                "description": "Set the transfer window for a token factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/settrnfwin.a.html",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory"
                    },
                    "transfer_window_start": {
                        "friendlyName": "Transfer window start",
                        "description": "Optional, the starting date for minting window"
                    },
                    "transfer_window_end": {
                        "friendlyName": "Transfer window end",
                        "description": "Optional, the ending date for minting window"
                    }
                }
            },
            "burn": {
                "friendlyName": "Burn a token",
                "description": "Burns token(s)",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/burn.html",
                "fields": {
                    "burn": {
                        "friendlyName": "Burn wrapper",
                        "fields": {
                            "owner": {
                                "friendlyName": "Owner",
                                "description": "Owner of the tokens to be burned"
                            },
                            "token_ids": {
                                "friendlyName": "Token IDs",
                                "description": "List of token IDs to burn",
                                "fields": {
                                    "id": {
                                        "friendlyName": "Token ID",
                                        "description": "ID of the token to burn"
                                    }
                                }
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            },
            "buy": {
                "friendlyName": "Purchase a token",
                "description": "Purchase a token from the resale marketplace",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/buy.html",
                "fields": {
                    "buy": {
                        "friendlyName": "buy wrapper",
                        "fields": {
                            "buyer": {
                                "friendlyName": "Buyer",
                                "description": "The account that pays for the uniq"
                            },
                            "receiver": {
                                "friendlyName": "Receiver",
                                "description": "The account that receives the uniq"
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            },
                            "token_id": {
                                "friendlyName": "Token ID",
                                "description": "ID of the Uniq to buy"
                            },
                            "max_price": {
                                "friendlyName": "Max Price",
                                "description": "Maximum amount of UOS that is allowed to be used for the purchase"
                            },
                            "promoter_id": {
                                "friendlyName": "Promoter ID",
                                "description": "The promoter account that receives commission"
                            }
                        }
                    }
                }
            },
            "cancelresell": {
                "friendlyName": "Cancel token resale",
                "description": "Cancel the resale of a token",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/cancelresell.html",
                "fields": {
                    "cancelresell": {
                        "friendlyName": "cancelresell wrapper",
                        "fields": {
                            "token_id": {
                                "friendlyName": "Token ID",
                                "description": "ID of the Uniq to cancel resale for"
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            },
            "transfer": {
                "friendlyName": "Transfer token",
                "description": "Transfer tokens to another user",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/transfer.html",
                "fields": {
                    "transfer": {
                        "friendlyName": "transfer wrapper",
                        "fields": {
                            "from": {
                                "friendlyName": "From",
                                "description": "The sending account"
                            },
                            "to": {
                                "friendlyName": "To",
                                "description": "The receiving account"
                            },
                            "token_ids": {
                                "friendlyName": "Token IDs",
                                "description": "List of token IDs to transfer",
                                "fields": {
                                    "id": {
                                        "friendlyName": "Token ID",
                                        "description": "ID of the token to transfer"
                                    }
                                }
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            },
            "resell": {
                "friendlyName": "Resell token",
                "description": "Place tokens for sale on the resell marketplace",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/resell.html",
                "fields": {
                    "resell": {
                        "friendlyName": "resell wrapper",
                        "fields": {
                            "seller": {
                                "friendlyName": "Seller",
                                "description": "The owner of the Uniq"
                            },
                            "token_id": {
                                "friendlyName": "Token ID",
                                "description": "ID of the Uniq to sell"
                            },
                            "price": {
                                "friendlyName": "Price",
                                "description": "The resale price"
                            },
                            "promoter_basis_point": {
                                "friendlyName": "Promoter Basis Points",
                                "description": "The resale promoter commission"
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            },
            "addgrpfcts": {
                "friendlyName": "Add factory to factory group",
                "description": "Adds factory IDs to a factory group",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/addgrpfcts.html",
                "fields": {
                    "id": {
                        "friendlyName": "Factory Group ID",
                        "description": "ID of the factory group in which the factories will be added"
                    },
                    "factories": {
                        "friendlyName": "Factory IDs",
                        "description": "List of factory IDs to add to the factory group",
                        "fields": {
                            "id": {
                                "friendlyName": "Factory ID",
                                "description": "ID of the token factory"
                            }
                        }
                    }
                }
            },
            "creategrp": {
                "friendlyName": "Create factory group",
                "description": "Creates a factory group",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/creategrp.html",
                "fields": {
                    "manager": {
                        "friendlyName": "Manager",
                        "description": "Factory group manager"
                    },
                    "uri": {
                        "friendlyName": "Metadata URI",
                        "description": "Factory group metadata URI"
                    },
                    "hash": {
                        "friendlyName": "Metadata Hash",
                        "description": "Factory group metadata hash"
                    },
                    "factories": {
                        "friendlyName": "Factory IDs",
                        "description": "List of factory IDs to add to the factory group",
                        "fields": {
                            "id": {
                                "friendlyName": "Factory ID",
                                "description": "ID of the token factory"
                            }
                        }
                    },
                    "max_uos_payment": {
                        "friendlyName": "Maximum UOS payment",
                        "description": "Maximum amount of UOS that is allowed to be used for the purposes of contract RAM usage"
                    }
                }
            },
            "deletegrp": {
                "friendlyName": "Delete factory group",
                "description": "Deletes a factory group with specified id",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/deletegrp.html",
                "fields": {
                    "id": {
                        "friendlyName": "Factory Group ID",
                        "description": "ID of the factory group to delete"
                    }
                }
            },
            "rmgrpfcts": {
                "friendlyName": "Remove factories from factory group",
                "description": "Remove factories from a factory group",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/rmgrpfcts.html",
                "fields": {
                    "id": {
                        "friendlyName": "Factory Group ID",
                        "description": "ID of the factory group from which the factories will be removed"
                    },
                    "factories": {
                        "friendlyName": "Factory IDs",
                        "description": "List of factory IDs to remove from the factory group",
                        "fields": {
                            "id": {
                                "friendlyName": "Factory ID",
                                "description": "ID of the token factory"
                            }
                        }
                    }
                }
            },
            "updategrp": {
                "friendlyName": "Update factory group",
                "description": "Updates factory group parameters: uri, hash and factory list",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/updategrp.html",
                "fields": {
                    "id": {
                        "friendlyName": "Factory Group ID",
                        "description": "ID of the factory group to update"
                    },
                    "uri": {
                        "friendlyName": "Metadata URI",
                        "description": "Factory group metadata URI"
                    },
                    "hash": {
                        "friendlyName": "Metadata Hash",
                        "description": "Factory group metadata hash"
                    },
                    "factories": {
                        "friendlyName": "Factory IDs",
                        "description": "List of new factory IDs to add to the factory group",
                        "fields": {
                            "id": {
                                "friendlyName": "Factory ID",
                                "description": "ID of the token factory"
                            }
                        }
                    }
                }
            },
            "setprchsreq.b": {
                "friendlyName": "Set first-hand purchase requirement",
                "description": "The factory manager can specify purchase options for users",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/setprchsreq.b",
                "fields": {
                    "purchase_option": {
                        "friendlyName": "Set purchase requirement wrapper",
                        "fields": {
                            "token_factory_id": {
                                "friendlyName": "Token factory ID",
                                "description": "ID of the token factory to assign first-hand purchase option"
                            },
                            "index": {
                                "friendlyName": "Purchase option index",
                                "description": "Index of the new or updated first-hand purchase option"
                            },
                            "price": {
                                "friendlyName": "Purchase price",
                                "description": "Price of the first-hand purchase in UOS or USD"
                            },
                            "purchase_limit": {
                                "friendlyName": "Purchase limit",
                                "description": "Optional, maximum number of Uniqs that can be purchased from this purchase option"
                            },
                            "promoter_basis_point": {
                                "friendlyName": "Promoter basis point",
                                "description": "UOS share received by the promoter with each purchase done for this option. Specified in basis points"
                            },
                            "purchase_option_with_uniqs": {
                                "friendlyName": "Purchase option with Uniqs",
                                "description": "Optional, require user to own Uniqs from specific factories or to pay with Uniqs from specific factories",
                                "fields": {
                                    "transfer_tokens_receiver_account": {
                                        "friendlyName": "Transfer tokens receiver account",
                                        "description": "This account will receive Uniqs if any of the purchase requirement with Uniqs include transfer (2) strategy"
                                    },
                                    "factories": {
                                        "friendlyName": "Required factories",
                                        "description": "List of purchase requirements using Uniqs from other factories",
                                        "fields": {
                                            "token_factory_id": {
                                                "friendlyName": "Token factory ID",
                                                "description": "Require user to own or burn/transfer Uniqs from this factory"
                                            },
                                            "count": {
                                                "friendlyName": "Count",
                                                "description": "Number of Uniqs required"
                                            },
                                            "strategy": {
                                                "friendlyName": "Strategy",
                                                "description": "How to process tokens from the specified factory. Can be either check (use 0), burn (use 1), transfer (use 2)"
                                            }
                                        }
                                    }
                                }
                            },
                            "sale_shares": {
                                "friendlyName": "Sale shares",
                                "description": "Share which each account receives during the purchase",
                                "fields": {
                                    "receiver": {
                                        "friendlyName": "Receiver",
                                        "description": "Sale share receiver account"
                                    },
                                    "basis_point": {
                                        "friendlyName": "Basis points",
                                        "description": "Sale share commission specified in basis points"
                                    }
                                }
                            },
                            "maximum_uos_payment": {
                                "friendlyName": "Maximum UOS payment",
                                "description": "Optional, maximum amount of UOS that is allowed to be used for the purposes of contract RAM usage"
                            },
                            "group_restriction": {
                                "friendlyName": "Group restriction",
                                "description": "Optional, user group restrictions for this purchase option. See documentation for details"
                            },
                            "purchase_window_start": {
                                "friendlyName": "Purchase window start",
                                "description": "Optional, the starting date for purchase window"
                            },
                            "purchase_window_end": {
                                "friendlyName": "Purchase window end",
                                "description": "Optional, the ending date for purchase window"
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            },
            "delprchsreq.a": {
                "friendlyName": "Delete first-hand purchase requirement",
                "description": "Deletes an existing purchase option of the factory with specified token_factory_id and purchase option with specified index",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/delprchsreq.a",
                "fields": {
                    "token_factory_id": {
                        "friendlyName": "Token factory ID",
                        "description": "ID of the token factory which has first-hand purchase option assigned to it"
                    },
                    "index": {
                        "friendlyName": "Purchase option index",
                        "description": "Index of an existing first-hand purchase option"
                    },
                    "memo": {
                        "friendlyName": "Memo",
                        "description": "Memo for the action"
                    }
                }
            },
            "purchase.a": {
                "friendlyName": "Purchase Uniqs directly",
                "description": "Makes a first-hand purchase from one of the purchase options of the factory",
                "documentation": "https://developers.ultra.io/blockchain/contracts/nft-contract/nft-actions/purchase.a",
                "fields": {
                    "purchase": {
                        "friendlyName": "Purchase wrapper",
                        "fields": {
                            "token_factory_id": {
                                "friendlyName": "Token factory ID",
                                "description": "ID of a token factory to purchase from"
                            },
                            "index": {
                                "friendlyName": "Index",
                                "description": "Index of first-hand purchase option to use"
                            },
                            "max_price": {
                                "friendlyName": "Maximum UOS payment",
                                "description": "Maximum amount of UOS you allow to be withdrawn from your account"
                            },
                            "buyer": {
                                "friendlyName": "Buyer",
                                "description": "Account that will pay UOS and/or Uniqs for this purchase"
                            },
                            "receiver": {
                                "friendlyName": "Receiver",
                                "description": "Account that will receive the Uniq from this purchase"
                            },
                            "promoter_id": {
                                "friendlyName": "Promoter",
                                "description": "Optional, promoter of the purchase transaction"
                            },
                            "user_uniqs": {
                                "friendlyName": "Provided user Uniqs",
                                "description": "List of Uniqs the buyer is willing to provide for this purchase option",
                                "fields": {
                                    "tokens": {
                                        "friendlyName": "Uniqs",
                                        "fields": {
                                            "token_id": {
                                                "friendlyName" : "Uniq ID",
                                                "description": "ID of the Uniq owned by buyer account which will be used to satisfy the purchase option requirement"
                                            },
                                            "strategy": {
                                                "friendlyName": "Strategy",
                                                "description": "How to process the token. Can be either check (use 0), burn (use 1), transfer (use 2). Must match the purchase option requirement"
                                            }
                                        }
                                    }
                                }
                            },
                            "memo": {
                                "friendlyName": "Memo",
                                "description": "Memo for the action"
                            }
                        }
                    }
                }
            }
        }
    };
}
