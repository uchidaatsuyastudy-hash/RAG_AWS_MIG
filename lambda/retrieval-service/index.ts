import { BedrockAgentRuntimeClient, AgenticRetrieveStreamCommand } from '@aws-sdk/client-bedrock-agent-runtime';

const client = new BedrockAgentRuntimeClient({});
const defaultKnowledgeBaseIds = (process.env.KNOWLEDGE_BASE_IDS ?? '').split(',').filter(Boolean);
const maxAgentIteration = Number(process.env.MAX_AGENT_ITERATION ?? '5');

export interface RetrievalRequest {
  /** The user's question. */
  question: string;
  /** Override the default Knowledge Base ARNs for this call (cross-KB search). */
  knowledgeBaseIds?: string[];
}

export interface RetrievalResponse {
  answer: string;
  results: unknown[];
  trace: unknown[];
}

const STREAM_ERROR_KEYS = [
  'internalServerException',
  'validationException',
  'resourceNotFoundException',
  'serviceQuotaExceededException',
  'throttlingException',
  'accessDeniedException',
  'conflictException',
  'dependencyFailedException',
  'badGatewayException',
] as const;

/**
 * Wraps Bedrock's AgenticRetrieveStream: a managed planner decomposes the
 * question into sub-queries, retrieves across one or more Knowledge Bases,
 * reranks results, and (optionally) synthesizes an answer with citations —
 * all in a single call, replacing the hand-rolled Query Decomposition /
 * Retrieval Grader / Ensemble Retrieval logic from the original PDF resources.
 */
export const handler = async (event: RetrievalRequest): Promise<RetrievalResponse> => {
  if (!event.question?.trim()) {
    throw new Error('event.question is required.');
  }
  const knowledgeBaseIds = event.knowledgeBaseIds?.length ? event.knowledgeBaseIds : defaultKnowledgeBaseIds;
  if (!knowledgeBaseIds.length) {
    throw new Error('No Knowledge Base IDs configured (set KNOWLEDGE_BASE_IDS or pass knowledgeBaseIds in the event).');
  }

  const command = new AgenticRetrieveStreamCommand({
    messages: [{ role: 'user', content: { text: event.question } }],
    retrievers: knowledgeBaseIds.map((id) => ({
      configuration: { knowledgeBase: { knowledgeBaseId: id } },
    })),
    agenticRetrieveConfiguration: {
      foundationModelType: 'MANAGED',
      rerankingModelType: 'MANAGED',
      maxAgentIteration,
    },
    generateResponse: true,
  });

  const response = await client.send(command);
  let answer = '';
  const results: unknown[] = [];
  const trace: unknown[] = [];

  if (response.stream) {
    for await (const chunk of response.stream) {
      if (chunk.responseEvent?.text) {
        answer += chunk.responseEvent.text;
      }
      if (chunk.result) {
        if (chunk.result.results) results.push(...chunk.result.results);
        if (chunk.result.generatedResponse?.answer) answer = chunk.result.generatedResponse.answer;
      }
      if (chunk.traceEvent) {
        trace.push(chunk.traceEvent);
      }
      for (const key of STREAM_ERROR_KEYS) {
        const err = chunk[key];
        if (err) {
          throw new Error(`AgenticRetrieveStream ${key}: ${err.message ?? 'unknown error'}`);
        }
      }
    }
  }

  // NOTE: do not log `answer`/`results` at INFO level in production — Knowledge
  // Base content can include anything ingested, not only public documents.
  return { answer, results, trace };
};
