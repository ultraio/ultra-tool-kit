import ajv from 'ajv';
import { FactorySchema, TokenSchema } from './schemas';

const ajvInstance = new ajv({ allowUnionTypes: true });

const SchemaBindings = {
    factory: FactorySchema,
    uniq: TokenSchema,
};

function validate(type: keyof typeof SchemaBindings, data: Object): { valid: boolean; errors: Object } {
    const validator = ajvInstance.compile(SchemaBindings[type]);
    const isValid = validator(data);
    return { valid: isValid, errors: validator.errors };
}

export const SchemaValidator = {
    validate,
};
