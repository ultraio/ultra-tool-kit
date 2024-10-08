export const FactorySchema = {
    type: 'object',
    title: 'FactoryMetadata',
    description: 'The NTF Factory metadata',
    properties: {
        specVersion: {
            type: 'string',
            enum: ['1.0'],
            description: 'The version of the NFT Factory metadata standard specification which the manifest uses. This enables the interpretation of the context. Compliant manifests MUST use a value of 0.1 when referring to this version of the specification.',
            pattern: '^1\\.0?$'
        },
        name: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Identifies the asset to which this NFT Factory represents',
        },
        subName: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'A secondary name that identify a special flavor of the asset to which this NFT represents. For example “Limited Edition”',
        },
        description: {
            type: 'string',
            description: 'Long description of the asset to which this NFT represents',
            maxLength: 4096,
        },
        author: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Specify the author(s) of the asset to which this NFT represents',
        },
        defaultLocale: {
            type: 'string',
            enum: ['en-US'],
            description: 'Specify the local of this metadata. The value must be one of the locales from the list available here: https://github.com/unicode-org/cldr-json/blob/master/cldr-json/cldr-core/availableLocales.json',
        },
        media: {
            description: 'Specify the advertising content for this NFT Factory',
            type: 'object',
            properties: {
                product: { $ref: '#/definitions/staticResource' },
                square: { $ref: '#/definitions/staticResource' },
                hero: { $ref: '#/definitions/staticResource' },
                gallery: {
                    description: 'A list of path pointing to images, videos... relative from this manifest relative from this manifest.',
                    type: 'array',
                    items: { $ref: '#/definitions/staticResource' },
                },
            },
            required: ['product', 'square'],
            additionalProperties: false,
        },
        properties: {
            description: 'Specify the properties for this NFT Factory',
            type: 'object',
            additionalProperties: true,
        },
        attributes: {
            description: 'Describes the attributes of each NFT generated by this factory',
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: {
                    dynamic: {
                        oneOf: [{ type: 'boolean' }, { type: 'null' }]
                    },
                    type: {
                        type: 'string',
                        enum: ['boolean', 'number', 'string', 'ISODateString'],
                    },
                    name: { type: 'string' },
                    description: { type: 'string' },
                },
                required: ['type', 'name'],
                additionalProperties: false,
            },
        },
        resources: {
            type: 'object',
            additionalProperties: { $ref: '#/definitions/staticResource' },
        },
    },
    required: ['specVersion', 'name', 'defaultLocale', 'media'],
    additionalProperties: false,
    definitions: {
        staticResource: {
            type: 'object',
            title: 'StaticResource',
            description: 'A static resource provides a hash to check integrity',
            properties: {
                contentType: { type: 'string' },
                uris: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                },
                integrity: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', enum: ['SHA256'] },
                        hash: {
                            type: 'string',
                            description: 'only 64 characters SHA256 hash is supported initially',
                            minLength: 64,
                            maxLength: 64,
                            pattern: '^([a-fA-F0-9]{2})+$',
                        },
                    },
                    required: ['type', 'hash'],
                    additionalProperties: false,
                },
            },
            required: ['contentType', 'uris', 'integrity'],
            additionalProperties: false,
        },
    },
};

export const TokenSchema = {
    type: 'object',
    title: 'TokenMetadata',
    description: 'The NFT metadata',
    properties: {
        serialNumber: {
            type: ['string', 'number'],
            description: 'A serial identifier of this token',
            nullable: true
        },
        specVersion: {
            type: 'string',
            enum: ['1.0'],
            description: 'The version of the NFT metadata standard specification which the manifest uses. This enables the interpretation of the context. Compliant manifests MUST use a value of 0.1 when referring to this version of the specification.',
            pattern: '^1\\.0?$'
        },
        name: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Identifies the asset to which this NFT represents'
        },
        subName: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'A secondary name that identify a special flavor of the asset to which this NFT represents. For example “Limited Edition”'
        },
        description: {
            type: 'string',
            description: 'Long description of the asset to which this NFT represents',
            maxLength: 4096
        },
        author: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Specify the author(s) of the asset to which this NFT represents'
        },
        defaultLocale: {
            type: 'string',
            enum: ['en-US'],
            description: 'Specify the local of this metadata. The value must be one of the locales from the list available here: https://github.com/unicode-org/cldr-json/blob/master/cldr-json/cldr-core/availableLocales.json'
        },
        media: {
            description: 'Specify the advertising content for this NFT',
            type: 'object',
            properties: {
                product: { $ref: '#/definitions/staticResource' },
                square: { $ref: '#/definitions/staticResource' },
                hero: { $ref: '#/definitions/staticResource' },
                gallery: {
                    description: 'A list of path pointing to images, videos... relative from this manifest relative from this manifest.',
                    type: 'array',
                    items: { $ref: '#/definitions/staticResource' }
                }
            },
            required: ['product', 'square'],
            additionalProperties: false
        },
        properties: {
            description: 'Specify the properties for this NFT',
            type: 'object',
            additionalProperties: true
        },
        attributes: {
            description: 'Specify the attributes for this NFT',
            type: 'object',
            additionalProperties: { type: ['boolean', 'number', 'string'] }
        },
        dynamicAttributes: { $ref: '#/definitions/dynamicResource' },
        resources: {
            type: 'object',
            additionalProperties: { $ref: '#/definitions/staticResource' }
        },
        dynamicResources: {
            type: 'object',
            additionalProperties: { $ref: '#/definitions/dynamicResource' }
        }
    },
    required: ['specVersion', 'name', 'defaultLocale', 'media'],
    additionalProperties: false,
    definitions: {
        staticResource: {
            type: 'object',
            title: 'StaticResource',
            description: 'A static resource provides a hash to check integrity',
            properties: {
                contentType: { type: 'string' },
                uris: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' }
                },
                integrity: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', enum: ['SHA256'] },
                        hash: {
                            type: 'string',
                            description: 'only 64 characters SHA256 hash is supported initially',
                            minLength: 64,
                            maxLength: 64,
                            pattern: '^([a-fA-F0-9]{2})+$'
                        }
                    },
                    required: ['type', 'hash'],
                    additionalProperties: false
                }
            },
            required: ['contentType', 'uris', 'integrity'],
            additionalProperties: false
        },
        dynamicResource: {
            type: 'object',
            title: 'DynamicResource',
            description: 'A dynamic resource can be refreshed to discover changes',
            properties: {
                contentType: { type: 'string' },
                uris: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' }
                }
            },
            required: ['contentType', 'uris'],
            additionalProperties: false
        }
    }
};
