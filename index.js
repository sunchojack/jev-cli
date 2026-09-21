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
    description: 'Evaluate a state against typed questions (noul/choice/score) via TypeSafe Jev and return typed answers with probabilities.',
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
