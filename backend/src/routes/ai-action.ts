// POST /api/ai-action — full chat pipeline. See docs/01-architecture.md §3.2.

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { chatMessages, chatSessions, incidents } from '../db/schema.js';
import { getProvider } from '../llm/router.js';
import { classifyIntent } from '../pipeline/classify.js';
import { recordUsage } from '../pipeline/cost.js';
import { buildPrompt } from '../pipeline/prompt.js';
import { retrieveActions } from '../pipeline/retrieve.js';
import { validateProposal } from '../pipeline/validate.js';
import { logger } from '../middleware/logging.js';

const requestSchema = z.object({
    sessionId: z.string().uuid(),
    messages: z
        .array(
            z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string(),
            })
        )
        .min(1),
    context: z.object({
        account: z.string(),
        permission: z.string(),
        endpoint: z.string(),
        chainId: z.string(),
        isAdmin: z.boolean(),
        knownAccounts: z.array(z.string()),
    }),
    model: z.string().optional(),
});

async function upsertSession(
    sessionId: string,
    userId: string,
    account: string,
    endpoint: string
): Promise<void> {
    await getDb()
        .insert(chatSessions)
        .values({ id: sessionId, userId, account, endpoint })
        .onConflictDoNothing({ target: chatSessions.id });
}

async function appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: Record<string, unknown>
): Promise<void> {
    await getDb().insert(chatMessages).values({ sessionId, role, content });
}

const app = new Hono();

app.post('/', async (c) => {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        return c.json(
            { kind: 'refuse', reason: 'invalid-request', detail: 'Body must be valid JSON.' },
            400
        );
    }

    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ');
        return c.json({ kind: 'refuse', reason: 'invalid-request', detail }, 400);
    }
    const body = parsed.data;
    const userId = c.get('userId');
    const db = getDb();
    const latestText = body.messages[body.messages.length - 1]?.content ?? '';

    try {
        await upsertSession(body.sessionId, userId, body.context.account, body.context.endpoint);
        await appendMessage(body.sessionId, 'user', { text: latestText });
    } catch (err) {
        logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: body.sessionId },
            '[ai-action] session/message persistence failed'
        );
        return c.json(
            { kind: 'refuse', reason: 'server-error', detail: 'Could not persist chat session.' },
            500
        );
    }

    let classifyResult: Awaited<ReturnType<typeof classifyIntent>>;
    try {
        classifyResult = await classifyIntent(body.messages);
    } catch (err) {
        logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            '[ai-action] classify failed'
        );
        const reply = {
            kind: 'refuse' as const,
            reason: 'classify-error',
            detail: 'I could not build a confident proposal — please rephrase.',
        };
        await appendMessage(body.sessionId, 'assistant', reply);
        return c.json(reply);
    }

    await recordUsage(
        { db },
        {
            sessionId: body.sessionId,
            userId,
            modelTag: classifyResult.modelTag,
            usage: classifyResult.usage,
            requestKind: 'classify',
        }
    );

    if (classifyResult.label === 'OFF_TOPIC') {
        await db.insert(incidents).values({
            userId,
            kind: 'off-topic',
            detail: { latest: latestText },
        });
        const reply = { kind: 'refuse' as const, reason: 'off-topic' };
        await appendMessage(body.sessionId, 'assistant', reply);
        return c.json(reply);
    }

    const retrieved = await retrieveActions(latestText, { isAdmin: body.context.isAdmin });
    if (retrieved.length === 0) {
        const reply = {
            kind: 'refuse' as const,
            reason: 'no-matches',
            detail: 'No matching action in the catalog.',
        };
        await appendMessage(body.sessionId, 'assistant', reply);
        return c.json(reply);
    }

    const prompt = await buildPrompt({
        retrieved,
        context: body.context,
        conversation: body.messages.slice(-6),
    });

    const chatProvider = getProvider('chat');
    let chatRes: Awaited<ReturnType<typeof chatProvider.chat>>;
    try {
        chatRes = await chatProvider.chat({
            system: prompt.system,
            user: prompt.user,
            toolSchema: prompt.toolSchema,
            maxTokens: 800,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, '[ai-action] chat provider failed');
        await db.insert(incidents).values({
            userId,
            kind: 'schema-fail',
            detail: { reason: 'provider-error', message },
        });
        const reply = { kind: 'refuse' as const, reason: 'provider-error' };
        await appendMessage(body.sessionId, 'assistant', reply);
        return c.json(reply);
    }

    const validated = await validateProposal(
        {
            raw: chatRes.json,
            retrieved,
            context: body.context,
            userId,
            sessionId: body.sessionId,
        },
        { db, log: logger }
    );

    await recordUsage(
        { db },
        {
            sessionId: body.sessionId,
            userId,
            modelTag: chatProvider.modelTag(),
            usage: chatRes.usage,
            requestKind: 'chat',
        }
    );

    await appendMessage(body.sessionId, 'assistant', validated);
    return c.json(validated);
});

export default app;
