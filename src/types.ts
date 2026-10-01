export const providerNames = ["codex", "claude", "antigravity"] as const;
export type ProviderName = (typeof providerNames)[number];
export type Message = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
};
export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type ProviderEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "done"; usage?: Usage; finishReason?: "stop" | "length" };
export type ProviderInput = {
  prompt: string;
  model?: string;
  sessionId?: string;
  workspace: string;
  signal: AbortSignal;
};
export interface Provider {
  run(input: ProviderInput): AsyncGenerator<ProviderEvent>;
}
export type Conversation = {
  id: string;
  provider: ProviderName;
  model: string;
  nativeModel?: string;
  sessionId?: string;
  status: "ready" | "running" | "interrupted";
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};
export type Config = {
  port: number;
  timeoutMs: number;
  providers: Record<
    ProviderName,
    { enabled: boolean; defaultModel?: string; models: string[] }
  >;
};
