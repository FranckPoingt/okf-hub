import { ai, type AxAIArgs, axGetAIProfile } from "@ax-llm/ax";

export type AIMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AIRequest = {
  messages: AIMessage[];
  document: {
    title: string;
    space: string;
    state: "draft" | "published" | "source";
    markdown: string;
  };
};

export type AIResponder = (request: AIRequest) => Promise<string>;

export function createAIResponder({
  provider,
  model,
  apiURL,
  apiKey,
}: {
  provider: string;
  model: string;
  apiURL?: string;
  apiKey?: string;
}): AIResponder {
  const profile = axGetAIProfile(provider);
  if (profile.transport === "webllm") {
    throw new Error("WebLLM is not available in the OKF server runtime");
  }
  const service = ai({
    name: profile.id,
    ...(apiURL ? { apiURL } : {}),
    apiKey,
    config: { model, maxTokens: 1_500, temperature: 0.2 },
  } as AxAIArgs<string>);
  return async ({ messages, document }) => {
    // ponytail: one document and 60k characters cover the first slice; add
    // retrieval when whole-space questions or larger documents ship.
    const markdown = document.markdown.slice(0, 60_000);
    const response = await service.chat({
      chatPrompt: [{
        role: "system",
        content:
          `You are Ask OKF, a read-only knowledge assistant. Answer from the supplied document only. If the answer is not present, say so plainly. Do not claim to edit, publish, approve, or run anything.

Document: ${document.title}
Space: ${document.space}
State: ${document.state}

<document>
${markdown}
</document>`,
      }, ...messages],
    }, { stream: false });
    if (response instanceof ReadableStream) {
      throw new Error("Expected a non-streaming AI response");
    }
    const answer = response.results.map((result) => result.content ?? "")
      .join("").trim();
    if (!answer) throw new Error("The AI provider returned an empty response");
    return answer;
  };
}
