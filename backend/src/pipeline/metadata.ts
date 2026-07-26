// Factory + Uniq metadata validators — Zod mirrors of the frontend's
// FactorySchema / TokenSchema JSON-Schema definitions.
//
// Source of truth: src/utilities/schemaValidator/schemas/index.ts
//   FactorySchema  (the NFT Factory metadata blob)
//   TokenSchema    (the per-Uniq token metadata blob)
// Verified source SHA-256: 48e1a786cf6c1d8f1d07b0965621692141568d3f0a96de03e3ab876a0bbdfeb0
//
// Intentional duplication: collapsing this into a shared module would couple
// frontend and backend builds, defeats roadmap §3's "separate boundaries" rule,
// and would pull AJV (or another JSON-Schema runtime) into the backend's
// dependency budget. Zod mirrors are cheaper to keep accurate via the parity
// CI grep (#10) which asserts each catalog `*-metadata.schema.json` has its
// source export under `src/utilities/schemaValidator/schemas/index.ts`.
//
// Each Zod schema MIRRORS one source field per the wave plan — no
// `z.passthrough()` / `z.any()` collapse. When the JSON-Schema feature genuinely
// cannot be captured cleanly in Zod (e.g. JSON-pointer cross-refs that Zod
// can't express without restructuring), the simplification is documented
// inline next to the field. Roadmap §6 row W5.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z, type ZodTypeAny } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Schema file loader — boot-time read; cached. Analogous to loadEosioTypes.
// Loaded for parity-check sanity and any future use; the runtime validators
// below are Zod-native and do NOT consume the loaded JSON.
// ─────────────────────────────────────────────────────────────────────────

const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'catalog');
const FACTORY_SCHEMA_PATH = join(CATALOG_DIR, 'factory-metadata.schema.json');
const UNIQ_SCHEMA_PATH = join(CATALOG_DIR, 'uniq-metadata.schema.json');

export type MetadataSchemas = {
    factory: Record<string, unknown>;
    uniq: Record<string, unknown>;
};

let cachedSchemas: MetadataSchemas | null = null;

export async function loadMetadataSchemas(opts: {
    factoryPath?: string;
    uniqPath?: string;
} = {}): Promise<MetadataSchemas> {
    const fPath = opts.factoryPath ?? FACTORY_SCHEMA_PATH;
    const uPath = opts.uniqPath ?? UNIQ_SCHEMA_PATH;
    const isDefault = fPath === FACTORY_SCHEMA_PATH && uPath === UNIQ_SCHEMA_PATH;
    if (isDefault && cachedSchemas) return cachedSchemas;
    const [factory, uniq] = await Promise.all([
        readFile(fPath, 'utf8').then((s) => JSON.parse(s) as Record<string, unknown>),
        readFile(uPath, 'utf8').then((s) => JSON.parse(s) as Record<string, unknown>),
    ]);
    const out: MetadataSchemas = { factory, uniq };
    if (isDefault) cachedSchemas = out;
    return out;
}

export function _resetMetadataSchemasCache(): void {
    cachedSchemas = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared sub-schemas. Each mirrors a `#/definitions/*` block in the source.
// ─────────────────────────────────────────────────────────────────────────

// `^([a-fA-F0-9]{2})+$` — pairs of hex chars; minLength/maxLength both 64 in
// source so the practical pattern is exactly 64 lowercase-or-uppercase hex
// characters. We enforce length AND regex (the source does both).
const HASH_HEX_RE = /^([a-fA-F0-9]{2})+$/;

const integritySchema = z
    .object({
        type: z.literal('SHA256'),
        hash: z
            .string()
            .min(64)
            .max(64)
            .regex(HASH_HEX_RE, 'must be hex pairs'),
    })
    .strict();

// staticResource — { contentType, uris (min 1), integrity } strict.
const staticResourceSchema = z
    .object({
        contentType: z.string(),
        uris: z.array(z.string()).min(1),
        integrity: integritySchema,
    })
    .strict();

// dynamicResource — { contentType, uris (min 1) } strict (uniq-only).
const dynamicResourceSchema = z
    .object({
        contentType: z.string(),
        uris: z.array(z.string()).min(1),
    })
    .strict();

// ─── factory media block ─────────────────────────────────────────────────
// `properties.product / square / hero / gallery` with required [product, square]
// and additionalProperties: false.
const factoryMediaSchema = z
    .object({
        product: staticResourceSchema,
        square: staticResourceSchema,
        hero: staticResourceSchema.optional(),
        gallery: z.array(staticResourceSchema).optional(),
    })
    .strict();

// factory attributes map: per-key `{dynamic?, type, name, description?}` with
// type enum boolean|number|string|ISODateString and required [type, name].
const factoryAttributeValueSchema = z
    .object({
        // oneOf: [{boolean}, {null}] — Zod can express as a union.
        dynamic: z.union([z.boolean(), z.null()]).optional(),
        type: z.enum(['boolean', 'number', 'string', 'ISODateString']),
        name: z.string(),
        description: z.string().optional(),
    })
    .strict();

// `additionalProperties: { type: object, ...}` — Zod's `record` enforces
// per-value shape; we ALSO want strict top-level (the parent map has only
// these arbitrary keys) which is the default for z.record.
const factoryAttributesSchema = z.record(z.string(), factoryAttributeValueSchema);

const factoryPropertiesSchema = z.object({}).passthrough();
// `properties` in the source has `additionalProperties: true` (anything goes
// inside, but the *block* itself must be an object). Use passthrough.

const factoryResourcesSchema = z.record(z.string(), staticResourceSchema);

// ─── FACTORY top-level ────────────────────────────────────────────────────
const factorySpecVersionSchema = z.literal('1.0');

const FactoryMetadataSchema = z
    .object({
        specVersion: factorySpecVersionSchema,
        name: z.string().min(1).max(256),
        subName: z.string().min(1).max(256).optional(),
        description: z.string().max(4096).optional(),
        author: z.string().min(1).max(256).optional(),
        defaultLocale: z.literal('en-US'),
        media: factoryMediaSchema,
        properties: factoryPropertiesSchema.optional(),
        attributes: factoryAttributesSchema.optional(),
        resources: factoryResourcesSchema.optional(),
    })
    .strict();

// ─── uniq media block ─────────────────────────────────────────────────────
const uniqMediaSchema = z
    .object({
        product: staticResourceSchema,
        square: staticResourceSchema,
        hero: staticResourceSchema.optional(),
        gallery: z.array(staticResourceSchema).optional(),
    })
    .strict();

// uniq attributes additionalProperties is a primitive union — boolean | number | string.
const uniqAttributesSchema = z.record(
    z.string(),
    z.union([z.boolean(), z.number(), z.string()])
);

const uniqPropertiesSchema = z.object({}).passthrough();
const uniqResourcesSchema = z.record(z.string(), staticResourceSchema);
const uniqDynamicResourcesSchema = z.record(z.string(), dynamicResourceSchema);

// ─── UNIQ top-level ───────────────────────────────────────────────────────
// serialNumber: type ['string','number'] + nullable: true. Mirror as union.
const uniqSerialNumberSchema = z.union([z.string(), z.number(), z.null()]).optional();

const UniqMetadataSchema = z
    .object({
        serialNumber: uniqSerialNumberSchema,
        specVersion: z.literal('1.0'),
        name: z.string().min(1).max(256),
        subName: z.string().min(1).max(256).optional(),
        description: z.string().max(4096).optional(),
        author: z.string().min(1).max(256).optional(),
        defaultLocale: z.literal('en-US'),
        media: uniqMediaSchema,
        properties: uniqPropertiesSchema.optional(),
        attributes: uniqAttributesSchema.optional(),
        dynamicAttributes: dynamicResourceSchema.optional(),
        resources: uniqResourcesSchema.optional(),
        dynamicResources: uniqDynamicResourcesSchema.optional(),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────
// Public validators. Errors are returned as path-prefixed readable strings —
// never thrown — so the gate-3 caller can fold them into a single ask.
// ─────────────────────────────────────────────────────────────────────────

export type MetadataResult = { ok: true } | { ok: false; errors: string[] };

function runValidator(schema: ZodTypeAny, value: unknown): MetadataResult {
    const r = schema.safeParse(value);
    if (r.success) return { ok: true };
    const errors = r.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
    });
    return { ok: false, errors };
}

export function validateFactoryMetadata(value: unknown): MetadataResult {
    return runValidator(FactoryMetadataSchema, value);
}

export function validateUniqMetadata(value: unknown): MetadataResult {
    return runValidator(UniqMetadataSchema, value);
}
