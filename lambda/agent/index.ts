import { BedrockRuntimeClient, ConverseCommand, type Message, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const bedrock = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});

const MODEL_ID = process.env.MODEL_ID!;
const RETRIEVAL_FUNCTION_NAME = process.env.RETRIEVAL_FUNCTION_NAME!;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID!;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION!;
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? '1024');
const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS ?? '4');

export interface AgentRequest {
  question: string;
}

export interface AgentResponse {
  answer: string;
  toolCalls: number;
}

const SYSTEM_PROMPT = [
  {
    text:
      'You are Metriever, a RAG assistant. Use the search_knowledge_base tool whenever a question ' +
      'could plausibly be answered from the ingested documents. Answer directly from your own ' +
      'knowledge only for general-knowledge questions clearly unrelated to those documents. ' +
      'Always say which source (tool results vs. general knowledge) your answer came from.',
  },
];

const TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'search_knowledge_base',
        description: 'Searches the ingested document Knowledge Base(s) for information relevant to a question.',
        inputSchema: {
          json: {
            type: 'object',
            properties: { query: { type: 'string', description: 'The search query.' } },
            required: ['query'],
          },
        },
      },
    },
  ],
};

async function callKnowledgeBase(query: string): Promise<string> {
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: RETRIEVAL_FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify({ question: query })),
    }),
  );
  const payload = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '{}';
  if (response.FunctionError) {
    return `Knowledge base search failed: ${payload}`;
  }
  const parsed = JSON.parse(payload) as { answer?: string; results?: unknown[] };
  return parsed.answer || JSON.stringify(parsed.results ?? []);
}

/**
 * Minimal agent loop implemented with Bedrock Converse tool-use, routing
 * between the RAG retrieval Lambda and the model's own general knowledge.
 *
 * NOTE: this replaces AgentCore Harness, the config-based managed agent
 * loop AWS recommends for new agent workloads. At the time this stack was
 * written, Harness had no AWS::BedrockAgentCore::* CloudFormation/CDK
 * support (Gateway, Runtime, Memory, Evaluation and Policy do), so wiring
 * Harness would have required building it entirely through an
 * AwsCustomResource against an undocumented, fast-moving control-plane API.
 * This Lambda is the documented AWS fallback pattern (Converse + tool use +
 * a Guardrail) for a small custom agent, and is functionally equivalent for
 * this project's RAG/general-knowledge routing need — it should be migrated
 * to a Harness construct once CDK/CloudFormation support ships.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  if (!event.question?.trim()) {
    throw new Error('event.question is required.');
  }

  const messages: Message[] = [{ role: 'user', content: [{ text: event.question }] }];
  let toolCalls = 0;

  for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM_PROMPT,
        messages,
        toolConfig: TOOL_CONFIG,
        inferenceConfig: { maxTokens: MAX_TOKENS },
        guardrailConfig: {
          guardrailIdentifier: GUARDRAIL_ID,
          guardrailVersion: GUARDRAIL_VERSION,
          trace: 'enabled',
        },
      }),
    );

    const outputMessage = response.output?.message;
    if (!outputMessage) {
      throw new Error('Converse returned no output message.');
    }

    if (response.stopReason !== 'tool_use' || iteration === MAX_TOOL_ITERATIONS) {
      const answer = (outputMessage.content ?? [])
        .map((block: ContentBlock) => block.text ?? '')
        .join('')
        .trim();
      return { answer, toolCalls };
    }

    messages.push(outputMessage);
    const toolResultContent: ContentBlock[] = [];
    for (const block of outputMessage.content ?? []) {
      if (block.toolUse?.name === 'search_knowledge_base') {
        toolCalls++;
        const query = (block.toolUse.input as { query?: string })?.query ?? event.question;
        const result = await callKnowledgeBase(query);
        toolResultContent.push({
          toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: result }] },
        });
      }
    }
    messages.push({ role: 'user', content: toolResultContent });
  }

  throw new Error('Exceeded max tool iterations without a final answer.');
};
