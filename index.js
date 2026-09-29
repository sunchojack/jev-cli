#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { evaluate } from './lib/client.mjs';

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
      model: z.string().optional(),
    }),
  },
  async (args) => {
    const data = await evaluate(args, { keychain: true });
    return { content: [{ type: 'text', text: JSON.stringify(data.answers) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
