export interface UniqResponse {
    factory: Factory;
    id: string;
    metadata: Metadata2;
    mintDate: string;
    owner: string;
    resale: Resale;
    serialNumber: string;
    tradingPeriod: TradingPeriod;
    transferPeriod: TransferPeriod;
    type: string;
}

export interface Factory {
    accountMintingLimit: string;
    assetCreator: string;
    assetManager: string;
    conditionlessReceivers: string[];
    defaultUniqMetadata: DefaultUniqMetadata;
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

export interface Resale {
    onSaleDate: string;
    price: Price;
    promoterBasisPoints: number;
    shares: Share[]
}

export interface Price {
    amount: any;
    currency: Currency;
}

export interface DefaultUniqMetadata {
    cachedSource: CachedSource;
    content: Content;
    source: Source;
    status: string;
}

export interface CachedSource {
    contentType: string;
    integrity: Integrity;
    uri: string;
}

export interface Integrity {
    hash: string;
    type: string;
}

export interface Content {
    attributes: any;
    description: string;
    dynamicAttributes: any;
    dynamicResources: any;
    medias: Medias;
    name: string;
    properties: any;
    resources: any;
    subName: string;
}

export interface Medias {
    gallery: Gallery[];
    hero: Hero;
    product: Product;
    square: Square;
}

export interface Gallery {
    contentType: string;
    integrity: Integrity;
    uri: string;
}

export interface Hero {
    contentType: string;
    integrity: Integrity;
    uri: string;
}

export interface Product {
    contentType: string;
    integrity: Integrity;
    uri: string;
}

export interface Square {
    contentType: string;
    integrity: Integrity;
    uri: string;
}

export interface Source {
    contentType: any;
    integrity: Integrity;
    uri: string;
}

export interface Metadata {
    cachedSource: CachedSource;
    content: Content2;
    locked: boolean;
    source: Source;
    status: string;
}

export interface Content2 {
    attributes: any;
    description: string;
    medias: Medias;
    name: string;
    properties: any;
    resources: any;
    subName: string;
}

export interface MintableWindow {
    endDate: any;
    startDate: any;
}

export interface Resale {
    minimumPrice: MinimumPrice;
    shares: Share[];
}

export interface MinimumPrice {
    amount: string;
    currency: Currency;
}

export interface Currency {
    code: string;
    symbol: string;
}

export interface Share {
    receiver: string;
    basisPoints: number;
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

export interface Metadata2 {
    cachedSource: CachedSource;
    content: Content3;
    source: Source;
    status: string;
}

export interface Content3 {
    attributes: any[];
    description: string;
    dynamicAttributes: any;
    dynamicResources: any;
    medias: Medias;
    name: string;
    properties: any;
    resources: any[];
    subName: string;
}

export interface TradingPeriod {
    duration: any;
    endDate: any;
    startDate: string;
}

export interface TransferPeriod {
    duration: any;
    endDate: any;
    startDate: string;
}
