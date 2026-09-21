import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', 'typesafe-api-key', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('TypeSafe API key not found (set TYPESAFE_API_KEY or store it in Keychain as service typesafe-api-key)');
  }
}

const KEY = apiKey();

const questionSchema = z.object({
  type: z.enum(['noul', 'choice', 'score']),
  instructions: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  criteria: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
});

const server = new McpServer({ name: 'jev-mcp', version: '0.1.0' });

server.registerTool(
  'judge',
  {
    title: 'Judge with Jev',
    description: 'TypeSafe Jev judgment tool. Call ONLY when a typed, probabilistic judgment is explicitly required: a yes/no probability (noul), a single choice from a defined set with a probability distribution (choice), or a rating on a described scale (score) over some state. Do NOT use for general reasoning, summarising, answering prose questions, or anything you could answer with your own inference. Use it when the caller names Jev or when the downstream step needs a machine-actionable probability distribution with your own threshold, not a sentence. Pass the full content and a self-contained question per id; ask independent questions together.',
    inputSchema: z.object({
      state: z.unknown(),
      questions: z.record(questionSchema),
    }),
  },
  async (args) => {
    const questions = z.record(questionSchema).parse(args.questions);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ state: args.state, model: MODEL, questions }),
    });
    if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.answers) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
