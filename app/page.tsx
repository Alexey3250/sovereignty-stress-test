"use client";

import { useMemo, useRef, useState } from "react";

type Status = "idle" | "streaming" | "done" | "error";

type Metrics = {
  ttft: number | null;
  totalMs: number | null;
  tokens: number | null;
};

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export default function Home() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({
    ttft: null,
    totalMs: null,
    tokens: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const isRtl = useMemo(() => ARABIC_RE.test(question), [question]);

  async function run() {
    if (!question.trim() || status === "streaming") return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStatus("streaming");
    setText("");
    setError(null);
    setMetrics({ ttft: null, totalMs: null, tokens: null });

    try {
      const res = await fetch("/api/cerebras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: ac.signal,
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleSseBlock(raw);
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError((err as Error).message);
      setStatus("error");
    }

    function handleSseBlock(raw: string) {
      const lines = raw.split("\n");
      let eventName = "message";
      let dataStr = "";
      for (const ln of lines) {
        if (ln.startsWith("event:")) eventName = ln.slice(6).trim();
        else if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
      }
      if (!dataStr) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        return;
      }

      if (eventName === "token") {
        setText((t) => t + String(payload.text ?? ""));
      } else if (eventName === "meta") {
        setMetrics((m) => ({ ...m, ttft: Number(payload.ttft) }));
      } else if (eventName === "done") {
        setMetrics({
          ttft: Number(payload.ttft),
          totalMs: Number(payload.totalMs),
          tokens: Number(payload.tokens),
        });
        setStatus("done");
      } else if (eventName === "error") {
        setError(String(payload.message ?? "Unknown error"));
        setStatus("error");
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Sovereignty Stress Test
        </h1>
        <p className="text-sm text-neutral-400">
          One question, multiple AI backends. Comparing latency, throughput, and quality.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          dir={isRtl ? "rtl" : "ltr"}
          placeholder="Ask a question about UAE government services..."
          rows={3}
          className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-base text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-500">
            {isRtl ? "RTL" : "LTR"} · Cmd/Ctrl+Enter to run
          </span>
          <button
            onClick={run}
            disabled={!question.trim() || status === "streaming"}
            className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {status === "streaming" ? "Running..." : "Run"}
          </button>
        </div>
      </section>

      <Card
        title="Cerebras · Qwen3 235B A22B Instruct"
        status={status}
        text={text}
        error={error}
        metrics={metrics}
        isRtl={isRtl}
      />
    </main>
  );
}

function Card({
  title,
  status,
  text,
  error,
  metrics,
  isRtl,
}: {
  title: string;
  status: Status;
  text: string;
  error: string | null;
  metrics: Metrics;
  isRtl: boolean;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/50">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm font-medium text-neutral-200">{title}</h2>
        <StatusBadge status={status} />
      </div>

      <div
        dir={isRtl ? "rtl" : "ltr"}
        className="min-h-[160px] whitespace-pre-wrap wrap-break-word px-4 py-4 text-[15px] leading-relaxed text-neutral-100"
      >
        {error ? (
          <span className="text-red-400">Error: {error}</span>
        ) : text ? (
          <>
            {text}
            {status === "streaming" && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-middle" />
            )}
          </>
        ) : (
          <span className="text-neutral-500">
            {status === "streaming" ? "Waiting for first token..." : "Idle."}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-neutral-800 px-4 py-2 font-mono text-xs text-neutral-400">
        <Metric label="TTFT" value={metrics.ttft != null ? `${metrics.ttft} ms` : "—"} />
        <Metric label="Total" value={metrics.totalMs != null ? `${metrics.totalMs} ms` : "—"} />
        <Metric label="Tokens" value={metrics.tokens != null ? String(metrics.tokens) : "—"} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "bg-neutral-800 text-neutral-400" },
    streaming: { label: "streaming", cls: "bg-blue-500/20 text-blue-300" },
    done: { label: "done", cls: "bg-emerald-500/20 text-emerald-300" },
    error: { label: "error", cls: "bg-red-500/20 text-red-300" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-neutral-500">{label}:</span> <span className="text-neutral-200">{value}</span>
    </span>
  );
}
