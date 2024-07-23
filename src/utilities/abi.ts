import * as I from '../interfaces/index';

export interface AbiTypes {
    new_type_name: string;
    type: string;
}

export interface AbiField {
    name: string;
    type: string;
}

export interface AbiStruct {
    name: string;
    base: string;
    fields: AbiField[];
}

export interface AbiAction {
    name: string;
    type: string;
    ricardian_contract: string;
}

export interface AbiTables {
    name: string;
    type: string;
    index_type: string;
    key_names: any[];
    key_types: any[];
}

export interface AbiVariants {
    name: string;
    types: string[];
}

export interface PrimitiveTypeData {
    defaultValue: any;
}

const primitiveTypes = {
    asset: {
        defaultValue: '0.00000000 UOS',
    },
    uint8: {
        defaultValue: 0,
    },
    uint16: {
        defaultValue: 0,
    },
    uint32: {
        defaultValue: 0,
    },
    uint64: {
        defaultValue: 0,
    },
    uint128: {
        defaultValue: 0,
    },
    int8: {
        defaultValue: 0,
    },
    int16: {
        defaultValue: 0,
    },
    int32: {
        defaultValue: 0,
    },
    int64: {
        defaultValue: 0,
    },
    float: {
        defaultValue: 0,
    },
    float64: {
        defaultValue: 0,
    },
    string: {
        defaultValue: '',
    },
    checksum256: {
        defaultValue: '',
    },
    name: {
        defaultValue: '',
    },
    time_point_sec: {
        defaultValue: '2021-05-31T00:00:00',
    },
    bool: {
        defaultValue: false,
    },
    public_key: {
        defaultValue: '',
    },
    symbol: {
        defaultValue: '8,UOS',
    },
    symbol_code: {
        defaultValue: 'UOS',
    },
    varuint32: {
        defaultValue: 0,
    },
    bytes: {
        defaultValue: '',
    },
};

export class FieldMetadata {
    isExpandable: boolean = true;
    isRequired: boolean = false;
    friendlyName?: string;
    description?: string;
    documentation?: string;
}

export class FieldData {
    abi: ABI;
    name: string;
    type: string;
    typeWithoutDecorators: string;
    isArray: boolean;
    isOptional: boolean;
    isBinaryExtension: boolean;
    isPrimitive: boolean;
    isProxyStruct: boolean = false;
    isStruct: boolean;
    metadata: FieldMetadata = new FieldMetadata();

    children?: FieldData[];

    constructor(
        name: string,
        type: string,
        abi: ABI,
        metadata: I.SmartContractMetadataAction | I.SmartContractMetadataActionField
    ) {
        this.abi = abi;

        // resale_share_vector? -> keep optional flag
        // resale_share_vector -> get underlying
        // resale_share[] -> keep resale_share as a type, keep vector tag
        // type: resale_share[]?
        // typeWithoutDecorators: resale_share
        // isArray: true, isOptional: true

        this.type = type;
        this.processType();

        this.name = name;

        this.isStruct = !this.isPrimitive;
        if (!this.isPrimitive) {
            this.children = [];

            let struct = this.abi.structs.find((x) => x.name === this.typeWithoutDecorators);
            if (struct) {
                if (this.isArray) {
                    this.children = [new FieldData(this.name, this.typeWithoutDecorators, this.abi, metadata)];
                } else {
                    this.populateParentType(struct.base, metadata);

                    for (let f of struct.fields) {
                        this.children.push(
                            new FieldData(f.name, f.type, this.abi, this.getMetadataChild(metadata, f.name))
                        );
                    }
                }
            } else {
                console.error(
                    `Non-primitive type that is not a struct available in ABI: ${this.typeWithoutDecorators}`
                );
                this.isPrimitive = true;
                this.isStruct = false;
            }
        } else if (this.isArray) {
            this.children = [
                new FieldData(
                    this.name,
                    this.typeWithoutDecorators,
                    this.abi,
                    this.getMetadataChild(metadata, undefined)
                ),
            ];
        }

        if (
            !this.isArray &&
            !this.isOptional &&
            !this.isBinaryExtension &&
            this.children &&
            this.children.length === 1
        ) {
            this.isProxyStruct = true;
            this.metadata.isExpandable = false;
            this.children[0].metadata.isExpandable = false;
        }

        this.populateMetadata(metadata);

        delete this.abi;
        //console.log(JSON.stringify(this, null, '\t'));
    }

    populateParentType(base: string, metadata: I.SmartContractMetadataAction | I.SmartContractMetadataActionField) {
        if (base && base.length > 0) {
            let struct = this.abi.structs.find((x) => x.name === base);

            if (struct) {
                this.populateParentType(struct.base, metadata);

                for (let f of struct.fields) {
                    this.children.push(
                        new FieldData(f.name, f.type, this.abi, this.getMetadataChild(metadata, f.name))
                    );
                }
            } else {
                console.error(`Parent type not found: ${base}`);
            }
        }
    }

    processType() {
        this.type = this.abi.getRealType(this.type);

        if (this.type === this.typeWithoutDecorators) {
            this.type = this.getWithDecorators();
            return;
        }


        this.isArray = this.isArray || this.type.indexOf('[]') >= 0;
        this.isOptional = this.isOptional || this.type.indexOf('?') >= 0;
        this.isBinaryExtension = this.isBinaryExtension || this.type.indexOf('$') >= 0;

        this.typeWithoutDecorators = this.getWithoutDecorators();
        this.isPrimitive = !!primitiveTypes[this.typeWithoutDecorators];

        if (!this.isPrimitive) {
            this.type = this.typeWithoutDecorators;
            this.processType();
        }
        this.type = this.getWithDecorators();
    }

    getMetadataChild(metadata: I.SmartContractMetadataAction | I.SmartContractMetadataActionField, childName: string) {
        if (!metadata) return undefined;
        if (!metadata.fields) return undefined;

        // get the first available
        if (!childName) {
            for (const property in metadata.fields) {
                return metadata.fields[property];
            }
            return undefined;
        }

        if (!metadata.fields[childName]) return undefined;
        return metadata.fields[childName];
    }

    populateMetadata(metadata: I.SmartContractMetadataAction | I.SmartContractMetadataActionField) {
        if (metadata) {
            this.metadata.description = metadata.description;
            this.metadata.friendlyName = metadata.friendlyName;
            this.metadata.documentation = (<I.SmartContractMetadataAction>metadata).documentation;
        }
        if (!this.metadata.friendlyName) this.metadata.friendlyName = this.name;
    }

    getWithoutDecorators() {
        let tmp = this.type;
        if (tmp.indexOf('[]') >= 0) tmp = tmp.substring(0, tmp.indexOf('[]'));
        if (tmp.indexOf('?') >= 0) tmp = tmp.substring(0, tmp.indexOf('?'));
        if (tmp.indexOf('$') >= 0) tmp = tmp.substring(0, tmp.indexOf('$'));
        return tmp;
    }

    getWithDecorators() {
        let tmp = this.typeWithoutDecorators;
        if (this.isArray) tmp += '[]';
        if (this.isOptional) tmp += '?';
        if (this.isBinaryExtension) tmp += '$';
        return tmp;
    }

    getDefaultValue() {
        if (this.isOptional) return null;
        if (this.isBinaryExtension) return undefined;
        if (this.isArray) return [];
        if (this.isStruct) return {};
        if (!this.isPrimitive) return undefined;
        if (primitiveTypes[this.typeWithoutDecorators]) return primitiveTypes[this.typeWithoutDecorators].defaultValue;
        return null;
    }
}

export class ABI {
    types: AbiTypes[];
    structs: AbiStruct[];
    actions: AbiAction[];
    tables: AbiTables[];
    variants: AbiVariants[];
    metadata: I.SmartContractMetadata;

    constructor(jsonResponse: any) {
        this.types = jsonResponse.types;
        this.structs = jsonResponse.structs;
        this.actions = jsonResponse.actions;
        this.tables = jsonResponse.tables;
        this.variants = jsonResponse.variants;
    }

    getActionType(actionName: string) {
        let act = this.actions.find((x) => x.name === actionName);
        let meta = undefined;
        if (this.metadata && this.metadata.actions[actionName]) meta = this.metadata.actions[actionName];
        let t = new FieldData(actionName, act.type, this, meta);
        // root action struct is not expandable for better UX
        t.metadata.isExpandable = false;
        return t;
    }

    getRealType(type: string) {
        if (this.types) {
            let newType = this.types.find((x) => x.new_type_name === type);
            if (newType) {
                return this.getRealType(newType.type);
            }
        }

        // TODO: better support variants
        // instead of returning the first possible type it should return all possible types
        // in the UI the dropdown selection should be presented to allow choosing the preferred option
        if (this.variants) {
            let variant = this.variants.find((x) => x.name === type);
            if (variant && variant.types && variant.types.length > 0) {
                if (variant.types.length > 1) {
                    console.error(`ABI variant with more than 1 possible type is not supported: ${type}`);
                }
                return this.getRealType(variant.types[0]);
            }
        }

        return type;
    }
}
