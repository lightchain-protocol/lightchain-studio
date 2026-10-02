import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/agent/chatStore';

function memento() {
	const data = new Map<string, unknown>();
	return { get: (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d), update: async (k: string, v: unknown) => { data.set(k, v); } } as never;
}

test('a chat starts with the first user message and merges streamed answers', () => {
	const store = new ChatStore(memento());
	store.record({ type: 'delta', text: 'ignored before any user message' });
	assert.equal(store.all().length, 0);

	store.record({ type: 'user', text: 'Make a token\nwith tests' }, 'llama3-8b');
	store.record({ type: 'delta', text: 'Sure, ' });
	store.record({ type: 'delta', text: 'writing it.' });
	store.closeAnswer();
	store.record({ type: 'toolStart', name: 'write_file', summary: 'Write src/Token.sol' });
	store.record({ type: 'status', text: 'live only' });
	store.record({ type: 'delta', text: 'Done.' });
	store.record({ type: 'checkpoint', id: 't1', files: ['src/Token.sol'] });

	const chat = store.current()!;
	assert.equal(chat.title, 'Make a token');
	assert.equal(chat.model, 'llama3-8b');
	assert.deepEqual(chat.events.map(e => e.type), ['user', 'ai', 'toolStart', 'ai', 'checkpoint']);
	assert.equal(chat.events[1].text, 'Sure, writing it.');
});

test('new chat, history and recap', async () => {
	const store = new ChatStore(memento());
	store.record({ type: 'user', text: 'first chat' });
	store.record({ type: 'delta', text: 'answer one' });
	const first = store.current()!.id;
	await store.startNew();
	assert.equal(store.current(), undefined);
	store.record({ type: 'user', text: 'second chat' });
	assert.equal(store.all().length, 2);
	assert.equal(store.all()[0].title, 'second chat'); // newest first

	const reopened = await store.open(first);
	assert.equal(reopened?.title, 'first chat');
	const recap = ChatStore.summary(reopened!);
	assert.match(recap, /User: first chat/);
	assert.match(recap, /Assistant: answer one/);

	await store.remove(first);
	assert.equal(store.all().length, 1);
	assert.equal(store.current(), undefined);
});
