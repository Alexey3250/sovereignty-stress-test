import type { NextRequest } from "next/server";

const ALLOWED_MODELS = [
  "llama3.1-8b",
  "qwen-3-235b-a22b-instruct-2507",
] as const;

type AllowedModel = (typeof ALLOWED_MODELS)[number];

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const SYSTEM_PROMPT =
  "You are a helpful assistant answering questions about UAE government services. Respond in the same language as the user's question. Be concise.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ServerEvent =
  | { type: "meta"; ttft: number }
  | { type: "token"; text: string }
  | { type: "done"; ttft: number; totalMs: number; tokens: number }
  | { type: "error"; message: string };

function sseLine(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) return jsonError("CEREBRAS_API_KEY not set", 500);

  let question: string;
  let model: AllowedModel;
  try {
    const body = await req.json();
    question = String(body?.question ?? "").trim();
    const requestedModel = String(body?.model ?? "");
    if (!question) throw new Error("empty question");
    if (!(ALLOWED_MODELS as readonly string[]).includes(requestedModel)) {
      return jsonError(
        `Invalid model. Allowed: ${ALLOWED_MODELS.join(", ")}`,
        400
      );
    }
    model = requestedModel as AllowedModel;
  } catch (err) {
    return jsonError(
      `Invalid body. Expect { question: string, model: string }. ${(err as Error).message}`,
      400
    );
  }

  const startedAt = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ServerEvent) => controller.enqueue(encoder.encode(sseLine(e)));

      let upstream: Response;
      try {
        upstream = await fetch(CEREBRAS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: question },
            ],
          }),
          signal: req.signal,
        });
      } catch (err) {
        send({ type: "error", message: `Upstream fetch failed: ${(err as Error).message}` });
        controller.close();
        return;
      }

      if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => "");
        send({
          type: "error",
          message: `Cerebras ${upstream.status}: ${txt.slice(0, 500) || upstream.statusText}`,
        });
        controller.close();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ttft = 0;
      let firstTokenSeen = false;
      let usageTokens = 0;
      let approxCompletionTokens = 0;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || !line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;

            let json: {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              usage?: { completion_tokens?: number; total_tokens?: number };
            };
            try {
              json = JSON.parse(payload);
            } catch {
              continue;
            }

            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                ttft = Date.now() - startedAt;
                send({ type: "meta", ttft });
              }
              approxCompletionTokens += 1;
              send({ type: "token", text: delta });
            }

            if (json.usage?.completion_tokens != null) {
              usageTokens = json.usage.completion_tokens;
            }
          }
        }

        const totalMs = Date.now() - startedAt;
        const tokens = usageTokens || approxCompletionTokens;
        send({ type: "done", ttft, totalMs, tokens });
      } catch (err) {
        send({ type: "error", message: `Stream error: ${(err as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
