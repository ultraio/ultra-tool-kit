// ActionRules — schema per backend/docs/01-architecture.md §5.2.

export type AuthRef = {
    actor: string;
    permission: string;
};

export type PreconditionKind = 'cross_field' | 'state' | 'invariant';

export type Precondition = {
    kind: PreconditionKind;
    expr: string;
    message: string;
};

export type FieldConstraint = {
    expr: string;
    message: string;
};

export type TimeConstant = {
    field: string;
    literal: string;
    seconds: number;
};

export type SourceLocation = {
    path: string;
    lines: [number, number];
};

export type AbiParam = {
    name: string;
    type: string;
};

export type ActionRules = {
    contract: string;
    action: string;
    params: AbiParam[];
    auths: AuthRef[];
    preconditions: Precondition[];
    field_constraints: Record<string, FieldConstraint[]>;
    recipients: string[];
    time_constants?: TimeConstant[];
    source: SourceLocation;
    unresolved?: boolean;
    notes?: string;
};

export type CatalogFile = {
    contract: string;
    abi_hash: string;
    abi_chain_id: string;
    abi_fetched_at: string;
    source_path: string;
    actions: Record<string, ActionRules>;
};

export class ExtractError extends Error {
    constructor(
        message: string,
        public readonly context: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'ExtractError';
    }
}
