import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export interface ChatOptions {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ChatResult {
  raw: ChatCompletion;
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  };
  costUsd: number;
}

const PRICE_PER_M_TOKEN: Record<string, { inHit: number; inMiss: number; out: number }> = {
  'deepseek-v4-flash': { inHit: 0.07, inMiss: 0.27, out: 1.1 },
  'deepseek-v4-pro': { inHit: 0.14, inMiss: 0.55, out: 2.19 },
  'deepseek-chat': { inHit: 0.07, inMiss: 0.27, out: 1.1 },
  'deepseek-reasoner': { inHit: 0.14, inMiss: 0.55, out: 2.19 },
};

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
    if (opts.thinking !== undefined) body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' };
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

    const raw = (await this.client.chat.completions.create(
      body as unknown as Parameters<typeof this.client.chat.completions.create>[0],
    )) as ChatCompletion;

    const usageRaw = raw.usage as
      | (ChatCompletion['usage'] & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number })
      | undefined;

    const promptTokens = usageRaw?.prompt_tokens ?? 0;
    const completionTokens = usageRaw?.completion_tokens ?? 0;
    const cacheHitTokens = usageRaw?.prompt_cache_hit_tokens ?? 0;
    const cacheMissTokens = usageRaw?.prompt_cache_miss_tokens ?? promptTokens - cacheHitTokens;

    const price = PRICE_PER_M_TOKEN[this.model] ?? PRICE_PER_M_TOKEN['deepseek-v4-flash']!;
    const costUsd =
      (cacheHitTokens * price.inHit + cacheMissTokens * price.inMiss + completionTokens * price.out) /
      1_000_000;

    return {
      raw,
      text: raw.choices[0]?.message?.content ?? '',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: usageRaw?.total_tokens ?? promptTokens + completionTokens,
        cacheHitTokens,
        cacheMissTokens,
      },
      costUsd,
    };
  }
}

export function createDeepSeekClient(modelOverride?: string): LLMClient {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY missing. Copy .env.example to .env and fill it in.');
  }
  return new LLMClient({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: modelOverride ?? process.env.DEEPSEEK_MODEL_FAST ?? 'deepseek-v4-flash',
  });
}
