"use client";

import { useMemo, useRef, useState } from "react";

type Status = "idle" | "streaming" | "done" | "error";

type Metrics = {
  ttft: number | null;
  totalMs: number | null;
  tokens: number | null;
};

type CardState = {
  status: Status;
  text: string;
  error: string | null;
  metrics: Metrics;
};

const MODELS = [
  { id: "llama3.1-8b", label: "Llama 3.1 · 8B" },
  { id: "qwen-3-235b-a22b-instruct-2507", label: "Qwen 3 · 235B" },
] as const;

const EXAMPLE_QUESTIONS = [
  {
    label: "Emirates ID renewal",
    text: "What documents do I need to renew my Emirates ID?",
  },
  {
    label: "Federal working hours",
    text: "What are the official working hours for UAE federal government employees?",
  },
  {
    label: "Visa overstay penalty",
    text: "What is the penalty for overstaying a UAE residence visa?",
  },
  {
    label: "بدل السكن",
    text: "ما هو بدل السكن للموظفين الاتحاديين في الإمارات؟",
  },
  {
    label: "تجديد الإقامة",
    text: "ما هي خطوات تجديد تأشيرة الإقامة في الإمارات؟",
  },
  {
    label: "How many R in strawberry",
    text: "How many R letters are in the word strawberry?",
  },
];

type ModelId = (typeof MODELS)[number]["id"];

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const EN_MARKER_RE = /ENGL[I\u064A]SH\s*:/i;
const AR_MARKER_RE = /ARAB[I\u064A]C\s*:/i;

type Phase = "preface" | "english" | "arabic";

type Bilingual = { english: string; arabic: string; phase: Phase };

function parseBilingual(text: string): Bilingual {
  const enMatch = EN_MARKER_RE.exec(text);
  const arMatch = AR_MARKER_RE.exec(text);

  if (!enMatch) {
    return { english: text, arabic: "", phase: "preface" };
  }

  const enIdx = enMatch.index;
  const enEnd = enIdx + enMatch[0].length;

  if (!arMatch || arMatch.index < enIdx) {
    const english = text.slice(enEnd).replace(/^\s+/, "");
    return { english, arabic: "", phase: "english" };
  }

  const arIdx = arMatch.index;
  const arEnd = arIdx + arMatch[0].length;
  const english = text.slice(enEnd, arIdx).trim();
  const arabic = text.slice(arEnd).replace(/^\s+/, "");
  return { english, arabic, phase: "arabic" };
}

function emptyCard(): CardState {
  return {
    status: "idle",
    text: "",
    error: null,
    metrics: { ttft: null, totalMs: null, tokens: null },
  };
}

function initialState(): Record<ModelId, CardState> {
  return MODELS.reduce(
    (acc, m) => {
      acc[m.id] = emptyCard();
      return acc;
    },
    {} as Record<ModelId, CardState>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [cards, setCards] = useState<Record<ModelId, CardState>>(initialState);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function pickExample(text: string) {
    setQuestion(text);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const len = text.length;
      el.setSelectionRange(len, len);
    }
  }

  const isRtl = useMemo(() => ARABIC_RE.test(question), [question]);
  const anyStreaming = useMemo(
    () => MODELS.some((m) => cards[m.id].status === "streaming"),
    [cards]
  );

  function patch(model: ModelId, fn: (s: CardState) => CardState) {
    setCards((prev) => ({ ...prev, [model]: fn(prev[model]) }));
  }

  async function streamModel(model: ModelId, question: string, signal: AbortSignal) {
    patch(model, () => ({
      status: "streaming",
      text: "",
      error: null,
      metrics: { ttft: null, totalMs: null, tokens: null },
    }));

    try {
      const res = await fetch("/api/cerebras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, model }),
        signal,
      });

      if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleBlock = (raw: string) => {
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
          const t = String(payload.text ?? "");
          patch(model, (s) => ({ ...s, text: s.text + t }));
        } else if (eventName === "meta") {
          patch(model, (s) => ({
            ...s,
            metrics: { ...s.metrics, ttft: Number(payload.ttft) },
          }));
        } else if (eventName === "done") {
          patch(model, (s) => ({
            ...s,
            status: "done",
            metrics: {
              ttft: Number(payload.ttft),
              totalMs: Number(payload.totalMs),
              tokens: Number(payload.tokens),
            },
          }));
        } else if (eventName === "error") {
          const msg = String(payload.message ?? "Unknown error");
          patch(model, (s) => ({ ...s, status: "error", error: msg }));
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleBlock(raw);
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = (err as Error).message;
      patch(model, (s) => ({ ...s, status: "error", error: msg }));
    }
  }

  function run() {
    const q = question.trim();
    if (!q || anyStreaming) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    void Promise.all(MODELS.map((m) => streamModel(m.id, q, ac.signal)));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Sovereignty Stress Test
        </h1>
        <p className="text-sm text-neutral-400">
          One question, four AI backends in parallel. Compare latency, throughput, and quality.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          dir={isRtl ? "rtl" : "ltr"}
          placeholder="Ask a question about UAE government services..."
          rows={3}
          className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-base text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
        />
        <div className="flex flex-col gap-2">
          <span className="text-xs text-neutral-500">Try:</span>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q.text}
                type="button"
                onClick={() => pickExample(q.text)}
                dir={ARABIC_RE.test(q.label) ? "rtl" : "ltr"}
                className="rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-500">
            {isRtl ? "RTL" : "LTR"} · Cmd/Ctrl+Enter to run
          </span>
          <button
            onClick={run}
            disabled={!question.trim() || anyStreaming}
            className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {anyStreaming ? "Running..." : "Run"}
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {MODELS.map((m) => (
          <Card key={m.id} title={m.label} state={cards[m.id]} />
        ))}
      </section>
    </main>
  );
}

function Card({ title, state }: { title: string; state: CardState }) {
  const { status, text, error, metrics } = state;
  const { english, arabic, phase } = useMemo(() => parseBilingual(text), [text]);
  const streaming = status === "streaming";

  return (
    <div className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
        <h2 className="text-sm font-medium text-neutral-200">{title}</h2>
        <StatusBadge status={status} />
      </div>

      {error ? (
        <div className="min-h-[180px] flex-1 px-5 py-4 text-[15px] leading-relaxed text-red-400">
          Error: {error}
        </div>
      ) : !text ? (
        <div className="min-h-[180px] flex-1 px-5 py-4 text-[15px] leading-relaxed text-neutral-500">
          {streaming ? "Waiting for first token..." : "Idle."}
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-1 divide-y divide-neutral-800 md:grid-cols-2 md:divide-x md:divide-y-0">
          <Pane
            label="EN"
            dir="ltr"
            content={english}
            placeholder={streaming ? "Waiting for ENGLISH marker..." : ""}
            showCursor={streaming && (phase === "preface" || phase === "english")}
          />
          <Pane
            label="ع"
            dir="rtl"
            content={arabic}
            placeholder={streaming ? "..." : ""}
            showCursor={streaming && phase === "arabic"}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-neutral-800 px-5 py-2 font-mono text-xs text-neutral-400">
        <Metric label="TTFT" value={metrics.ttft != null ? `${metrics.ttft} ms` : "—"} />
        <Metric label="Total" value={metrics.totalMs != null ? `${metrics.totalMs} ms` : "—"} />
        <Metric label="Tokens" value={metrics.tokens != null ? String(metrics.tokens) : "—"} />
      </div>
    </div>
  );
}

function Pane({
  label,
  dir,
  content,
  placeholder,
  showCursor,
}: {
  label: string;
  dir: "ltr" | "rtl";
  content: string;
  placeholder: string;
  showCursor: boolean;
}) {
  const hasContent = content.length > 0;
  return (
    <div className="flex min-h-[180px] flex-col gap-2 bg-neutral-950/30 px-5 py-4">
      <div
        dir="ltr"
        className={`flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-neutral-500 ${
          dir === "rtl" ? "justify-end" : "justify-start"
        }`}
      >
        <span className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-neutral-300">
          {label}
        </span>
      </div>
      <div
        dir={dir}
        lang={dir === "rtl" ? "ar" : "en"}
        className="flex-1 whitespace-pre-wrap wrap-break-word text-[15px] leading-relaxed text-neutral-100"
      >
        {hasContent ? (
          <>
            {content}
            {showCursor && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-middle" />
            )}
          </>
        ) : (
          <span className="text-neutral-500">
            {placeholder}
            {showCursor && (
              <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-middle" />
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const dot: Record<Status, string> = {
    idle: "bg-neutral-500",
    streaming: "bg-blue-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
  };
  const text: Record<Status, string> = {
    idle: "text-neutral-400",
    streaming: "text-blue-300",
    done: "text-emerald-300",
    error: "text-red-300",
  };
  return (
    <span className={`flex items-center gap-2 text-xs font-medium ${text[status]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot[status]}`} />
      {status}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-neutral-500">{label}:</span>{" "}
      <span className="text-neutral-200">{value}</span>
    </span>
  );
}
