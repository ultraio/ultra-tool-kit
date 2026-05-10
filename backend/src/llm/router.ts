import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { ProviderError, type ChatProvider, type Provider } from './provider.js';

export type Role = 'chat' | 'embed' | 'classifier';

export type RouterBundle = {
    chat: ChatProvider;
    embed: ChatProvider;
    classifier: ChatProvider;
};

const PROVIDER_VALUES: readonly Provider[] = ['anthropic', 'openai', 'ollama'];

const cache = new Map<Provider, ChatProvider>();

function isProvider(v: string): v is Provider {
    return (PROVIDER_VALUES as readonly string[]).includes(v);
}

function readEnv(varName: string): string | undefined {
    const raw = process.env[varName];
    return raw && raw.length > 0 ? raw : undefined;
}

function parseProvider(envVar: string, raw: string): Provider {
    if (!isProvider(raw)) {
        throw new ProviderError(`Unknown ${envVar}: ${raw}`, { provider: raw });
    }
    return raw;
}

function resolveProviderName(role: Role): Provider {
    const chatDefault = parseProvider('LLM_PROVIDER', readEnv('LLM_PROVIDER') ?? 'ollama');
    if (role === 'chat') return chatDefault;
    const envVar = role === 'embed' ? 'EMBED_PROVIDER' : 'CLASSIFIER_PROVIDER';
    return parseProvider(envVar, readEnv(envVar) ?? chatDefault);
}

function instantiate(name: Provider): ChatProvider {
    const cached = cache.get(name);
    if (cached) return cached;
    let created: ChatProvider;
    switch (name) {
        case 'anthropic':
            created = new AnthropicProvider();
            break;
        case 'openai':
            created = new OpenAIProvider();
            break;
        case 'ollama':
            created = new OllamaProvider();
            break;
    }
    cache.set(name, created);
    return created;
}

export function getProvider(role: Role): ChatProvider {
    return instantiate(resolveProviderName(role));
}

export function getRouter(): RouterBundle {
    return {
        chat: getProvider('chat'),
        embed: getProvider('embed'),
        classifier: getProvider('classifier'),
    };
}

export function resetRouterCache(): void {
    cache.clear();
}
