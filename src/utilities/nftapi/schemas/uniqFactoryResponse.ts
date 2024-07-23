export interface UniqFactoryResponse {
    accountMintingLimit: string | null;
    assetCreator: string;
    assetManager: string;
    conditionlessReceivers: string[];
    defaultUniqMetadata: DefaultUniqMetadata;
    firsthandPurchases: FirsthandPurchase[];
    id: string;
    metadata: Metadata;
    mintableWindow: MintableWindow;
    resale: Resale;
    status: string;
    stock: Stock;
    tradingWindow: TradingWindow;
    transferWindow: TransferWindow;
    type: string;
}

export interface FirsthandPurchase {
    id: string;
    groupRestriction: FirsthandPurchaseGroupRestriction[];
    option: FirsthandPurchaseOption;
    price: MinimumPrice;
    promoterBasisPoints: string;
    purchaseLimit: string;
    purchaseWindow: PurchaseWindow;
    purchasedUniqs: string;
    saleShares: Share[];
    uosPayment: string;
}

export interface FirsthandPurchaseGroupRestriction {
    excludes: string[];
    includes: string[];
}

export interface FirsthandPurchaseOption {
    transferUniqsReceiver: string;
    factories: FirsthandPurchaseOptionFactory[];
}

export interface FirsthandPurchaseOptionFactory {
    count: string;
    id: string;
    strategy: string;
}

export interface PurchaseWindow {
    endDate: any;
    startDate: any;
}

export interface DefaultUniqMetadata {
    cachedSource: Source;
    content: Content;
    source: Source;
    status: string;
}

export interface Integrity {
    hash: string;
    type: string;
}

export interface FactoryAttributes {
    key: string;
    value: {
        name: string;
        description: string;
        dynamic: boolean | null;
    };
}

export interface Content {
    attributes?: FactoryAttributes[] | { [key: string]: boolean | string | number };
    description: string;
    dynamicAttributes: any;
    dynamicResources?: { [key: string]: DynamicResource };
    medias: Medias;
    name: string;
    properties: any;
    resources?: { [key: string]: Source };
    subName: string;
}

export interface Content2 {
    attributes?: FactoryAttributes[];
    description: string;
    medias: Medias;
    name: string;
    properties: any;
    resources?: { [key: string]: Source };
    subName: string;
}

export interface Medias {
    gallery: Source[];
    hero: Source;
    product: Source;
    square: Source;
}

export interface Source {
    contentType: any;
    integrity: Integrity;
    uri: string;
}

export interface DynamicResource {
    contentType: string;
    uris: string[];
}

export interface Metadata {
    cachedSource: Source;
    content: Content2;
    locked: boolean;
    source: Source;
    status: string;
}

export interface MintableWindow {
    endDate: any;
    startDate: any;
}

export interface Resale {
    minimumPrice: MinimumPrice;
    shares: Share[];
}

export interface Share {
    receiver: string;
    basisPoints: number;
}

export interface MinimumPrice {
    amount: string;
    currency: Currency;
}

export interface Currency {
    code: string;
    symbol: string;
}

export interface Stock {
    authorized: any;
    existing: string;
    maxMintable: string;
    mintable: string;
    minted: string;
}

export interface TradingWindow {
    endDate: any;
    startDate: any;
}

export interface TransferWindow {
    endDate: any;
    startDate: any;
}
