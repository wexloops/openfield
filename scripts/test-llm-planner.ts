/**
 * The Scene planner against a fake OpenAI-compatible server, no LLM needed:
 * `npm run test:llm-planner`.
 *
 * Covers what servers differ in: a refused option is dropped and the request
 * repeated (JSON mode, then reasoning_effort, then streaming), a reply in one
 * piece instead of a stream, a stream that breaks off after some shots, the
 * Think first switch, and a server that lists several models.
 */
import assert from 'assert/strict';
import { createServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const SHOTS = [
  { framing: 'wide', move: 'crane-up', action: 'A keeper climbs the tower stairs in the storm.', seconds: 4 },
  { framing: 'medium', move: 'handheld', action: 'He drags himself up the wet iron steps.', seconds: 3 },
  { framing: 'close', move: 'push-in', action: 'He strikes a match and lights the lamp.', seconds: 3 },
];
const LIST = JSON.stringify({ shots: SHOTS });
/** The reply cut right after the second shot's closing brace. */
const TWO = LIST.slice(0, LIST.indexOf('}', LIST.indexOf('}') + 1) + 1);

/** How the fake server behaves in the current check. */
let mode: { models?: string[]; refuse?: ('response_format' | 'reasoning_effort' | 'stream')[]; plain?: boolean; breakAfterTwo?: boolean } = {};
const bodies: Record<string, unknown>[] = [];

const sse = (res: ServerResponse, delta: Record<string, string>) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: (mode.models ?? ['test-model']).map((id) => ({ id })) }));
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    if ((mode.refuse ?? []).some((k) => k in body && body[k] !== false)) {
      res.statusCode = 400;
      return res.end('{"error":"unsupported"}');
    }
    if (mode.plain || !body.stream) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: LIST } }] }));
    }
    res.setHeader('content-type', 'text/event-stream');
    sse(res, { reasoning_content: 'Three beats: the climb, the steps, the lamp.' });
    sse(res, { content: TWO });
    // Drop the connection once the two shots are on the wire (destroy discards what is not sent yet).
    if (mode.breakAfterTwo) return void setTimeout(() => res.destroy(), 50);
    sse(res, { content: LIST.slice(TWO.length) });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

// scene.ts reads these when it loads; empty values keep this machine's .env out.
Object.assign(process.env, {
  OPENFIELD_LLM_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  OPENFIELD_LLM_MODEL: '', OPENFIELD_LLM_KEY: '', OPENFIELD_LLM_REASONING: '',
  OPENFIELD_DATA: join(tmpdir(), 'openfield-test-llm-planner'),
});
const { getPlan, startPlan } = await import('../server/scene.js');

async function plan(think = false) {
  bodies.length = 0;
  const id = startPlan('A keeper climbs the lighthouse in a storm and lights the lamp.', { shots: 3, planner: 'llm', think }).id;
  for (let i = 0; i < 200; i++) {
    const p = getPlan(id)!;
    if (p.status !== 'running') return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the plan did not finish');
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

await check('a streamed reply becomes the plan, asked with JSON mode and no reasoning', async () => {
  mode = {};
  const p = await plan();
  assert.equal(p.planner, 'llm');
  assert.deepEqual(p.shots?.map((s) => s.action), SHOTS.map((s) => s.action));
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[0].reasoning_effort, 'none');
  assert.equal(bodies[0].model, 'test-model');
});

await check('Think first sends no reasoning_effort', async () => {
  mode = {};
  await plan(true);
  assert.ok(!('reasoning_effort' in bodies[0]));
});

await check('refused JSON mode, then refused reasoning_effort: asked again without each, with a note', async () => {
  mode = { refuse: ['response_format', 'reasoning_effort'] };
  const p = await plan();
  assert.equal(p.planner, 'llm');
  assert.equal(bodies.length, 3);
  assert.ok(!('response_format' in bodies[2]) && !('reasoning_effort' in bodies[2]));
  assert.ok(p.notes.some((n) => /refused reasoning_effort/.test(n)), p.notes.join(' | '));
});

await check('refused streaming: asked in one piece', async () => {
  mode = { refuse: ['response_format', 'stream'] };
  const p = await plan();
  assert.equal(p.planner, 'llm');
  assert.equal(bodies.at(-1)!.stream, false);
});

await check('a server that ignores stream and answers in one piece works', async () => {
  mode = { plain: true };
  const p = await plan();
  assert.equal(p.shots?.length, 3);
});

await check('a stream that breaks off keeps the shots written before it, with a note', async () => {
  mode = { breakAfterTwo: true };
  const p = await plan();
  assert.equal(p.planner, 'llm');
  assert.deepEqual(p.shots?.map((s) => s.action), SHOTS.slice(0, 2).map((s) => s.action));
  assert.ok(p.notes.some((n) => /broke off after 2 shots/.test(n)), p.notes.join(' | '));
});

await check('a server that lists several models is not guessed at: set OPENFIELD_LLM_MODEL', async () => {
  mode = { models: ['embedding-model', 'chat-model'] };
  const p = await plan();
  assert.equal(p.planner, 'split');
  assert.equal(bodies.length, 0, 'no chat request');
  assert.ok(p.notes.some((n) => /lists 2 models; set OPENFIELD_LLM_MODEL/.test(n)), p.notes.join(' | '));
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
