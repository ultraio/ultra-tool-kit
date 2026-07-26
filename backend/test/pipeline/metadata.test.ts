// Metadata validators — Zod mirrors of the FactorySchema / TokenSchema
// JSON-Schema definitions in src/utilities/schemaValidator/schemas/index.ts.
//
// Coverage: happy path for each schema, every gate the source schema exposes
// (required fields, additionalProperties:false, nested type, hash regex,
// literal enums, factory-attribute-shape requirement). Catches regressions
// against the frontend schema source when the parity grep #10 alone wouldn't.

import { describe, expect, it } from 'vitest';

import {
    validateFactoryMetadata,
    validateUniqMetadata,
} from '../../src/pipeline/metadata.js';

// 64-char hex SHA-256 sample.
const HASH64 = '6409d3c8fb3ce3b47a32fcd194362afb7fd004b22bc2b05939c89c99c76c9c38';

function makeStaticResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        contentType: 'image/png',
        uris: ['ipfs://hash'],
        integrity: { type: 'SHA256', hash: HASH64 },
        ...overrides,
    };
}

function makeMinimalFactory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        specVersion: '1.0',
        name: 'My NFT Factory',
        defaultLocale: 'en-US',
        media: {
            product: makeStaticResource(),
            square: makeStaticResource(),
        },
        ...overrides,
    };
}

function makeMinimalUniq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        specVersion: '1.0',
        name: 'My Uniq',
        defaultLocale: 'en-US',
        media: {
            product: makeStaticResource(),
            square: makeStaticResource(),
        },
        ...overrides,
    };
}

describe('validateFactoryMetadata — happy path', () => {
    it('accepts a minimum complete factory metadata', () => {
        const res = validateFactoryMetadata(makeMinimalFactory());
        expect(res.ok).toBe(true);
    });

    it('accepts a full factory metadata with all optional fields', () => {
        const res = validateFactoryMetadata(
            makeMinimalFactory({
                subName: 'Limited Edition',
                description: 'A wonderful collection',
                author: 'duncan',
                properties: { rarity: 'epic', anything: true },
                attributes: {
                    color: { type: 'string', name: 'Color' },
                    rare: { dynamic: true, type: 'boolean', name: 'Rare', description: 'Rarity flag' },
                    other: { dynamic: null, type: 'number', name: 'Other' },
                },
                resources: {
                    extra: makeStaticResource(),
                },
                media: {
                    product: makeStaticResource(),
                    square: makeStaticResource(),
                    hero: makeStaticResource(),
                    gallery: [makeStaticResource(), makeStaticResource()],
                },
            })
        );
        expect(res.ok).toBe(true);
    });
});

describe('validateFactoryMetadata — failures', () => {
    it('rejects missing required field "name" with a path-prefixed error', () => {
        const obj = makeMinimalFactory();
        delete obj.name;
        const res = validateFactoryMetadata(obj);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.some((e) => e.startsWith('name'))).toBe(true);
        }
    });

    it('rejects an extra unknown top-level field (additionalProperties:false)', () => {
        const res = validateFactoryMetadata(makeMinimalFactory({ unexpectedField: 'x' }));
        expect(res.ok).toBe(false);
    });

    it('rejects bad nested type (media.product.contentType not string)', () => {
        const res = validateFactoryMetadata(
            makeMinimalFactory({
                media: {
                    product: { ...makeStaticResource(), contentType: 42 },
                    square: makeStaticResource(),
                },
            })
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.some((e) => e.includes('media.product.contentType'))).toBe(true);
        }
    });

    it('rejects an integrity.hash with non-hex characters', () => {
        const badHash = 'z'.repeat(64);
        const res = validateFactoryMetadata(
            makeMinimalFactory({
                media: {
                    product: makeStaticResource({
                        integrity: { type: 'SHA256', hash: badHash },
                    }),
                    square: makeStaticResource(),
                },
            })
        );
        expect(res.ok).toBe(false);
    });

    it('rejects specVersion ≠ "1.0"', () => {
        const res = validateFactoryMetadata(makeMinimalFactory({ specVersion: '2.0' }));
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.some((e) => e.startsWith('specVersion'))).toBe(true);
        }
    });

    it('rejects a factory attribute missing required "type"', () => {
        // attributes.additionalProperties requires [type, name]
        const res = validateFactoryMetadata(
            makeMinimalFactory({
                attributes: {
                    badAttr: { name: 'Bad', description: 'missing type' },
                },
            })
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.some((e) => e.includes('attributes.badAttr'))).toBe(true);
        }
    });
});

describe('validateUniqMetadata — happy path', () => {
    it('accepts a minimum complete uniq metadata', () => {
        const res = validateUniqMetadata(makeMinimalUniq());
        expect(res.ok).toBe(true);
    });

    it('accepts attributes with primitive values (boolean | number | string)', () => {
        const res = validateUniqMetadata(
            makeMinimalUniq({
                attributes: {
                    name: 'cool', rare: true, count: 7,
                },
            })
        );
        expect(res.ok).toBe(true);
    });
});

describe('validateUniqMetadata — failures', () => {
    it('rejects missing required field "media"', () => {
        const obj = makeMinimalUniq();
        delete obj.media;
        const res = validateUniqMetadata(obj);
        expect(res.ok).toBe(false);
    });

    it('rejects an extra unknown top-level field', () => {
        const res = validateUniqMetadata(makeMinimalUniq({ unexpectedField: 'x' }));
        expect(res.ok).toBe(false);
    });

    it('rejects non-primitive attribute value', () => {
        const res = validateUniqMetadata(
            makeMinimalUniq({
                attributes: {
                    bad: { not: 'a primitive' },
                },
            })
        );
        expect(res.ok).toBe(false);
    });
});
