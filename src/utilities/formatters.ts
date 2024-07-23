export function formatTradabilityValue(start: string, end: string) {
    if (start == null && end == null) {
        return 'Tradable Forever';
    }

    if (start == null && end === '1970-01-01T00:00:00.000Z') {
        return `Non-tradable`;
    }

    if (start == null && !!end) {
        return `Tradeable until ${end}`;
    }

    if (!!start && end == null) {
        return `Tradeable from ${start}`;
    }

    if (!!start && !!end) {
        return `Tradeable from ${start} to ${end}`;
    }
}

export function formatTransferabilityValue(start: string, end: string) {
    if (start == null && end == null) {
        return 'Transferable Forever';
    }

    if (start == null && end === '1970-01-01T00:00:00.000Z') {
        return `Non-transferable`;
    }

    if (start == null && !!end) {
        return `Transferable until ${end}`;
    }

    if (!!start && end == null) {
        return `Transferable from ${start}`;
    }

    if (!!start && !!end) {
        return `Transferable from ${start} to ${end}`;
    }
}

export function formatIfNull(val: string) {
    return val ? val : 'null';
}

export function stripQuotes(str: string) {
    if (typeof str !== 'string') return str;
    return str.replace(/^"(.*)"$/, '$1');
}
