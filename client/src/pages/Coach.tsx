import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export default function Coach() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const { data: history, isLoading } = useQuery({ queryKey: ["chat"], queryFn: api.chatHistory });

  const send = useMutation({
    mutationFn: (message: string) => api.chat(message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat"] });
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
    },
  });

  function submit() {
    const message = draft.trim();
    if (!message || send.isPending) return;
    setDraft("");
    send.mutate(message);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">Coach</div>
        <h1>Tell it what you're training for</h1>
      </div>

      <div className="panel">
        <div className="stack" style={{ gap: 10, minHeight: 240 }}>
          {isLoading && <div className="skeleton" style={{ width: "45%" }} />}

          {history?.length === 0 && !send.isPending && (
            <div className="small muted" style={{ lineHeight: 1.6 }}>
              Describe your goals the way you'd say them out loud — "I've got an Ironman in nine months and
              a wedding in six weeks I want to look good for." It'll ask what it still needs, then create
              the goals itself.
            </div>
          )}

          {history?.map((message, i) => (
            <div key={i} className={`bubble ${message.role === "user" ? "bubble-user" : "bubble-assistant"}`}>
              {message.content}
            </div>
          ))}

          {send.isPending && <div className="bubble bubble-assistant muted">Thinking…</div>}
        </div>

        {send.data && send.data.toolResults.length > 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            <div className="section-label" style={{ color: "var(--primary)", marginBottom: 4 }}>
              Actions taken
            </div>
            {send.data.toolResults.map((result, i) => (
              <div key={i} className="small">
                {result}
              </div>
            ))}
          </div>
        )}

        {send.error && <div className="notice notice-danger" style={{ marginTop: 12 }}>{(send.error as Error).message}</div>}

        <div className="divider" />

        <div className="row" style={{ gap: 8 }}>
          <input
            value={draft}
            placeholder="I have a marathon in September and want to be lean for a wedding in June…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button className="btn-primary" disabled={!draft.trim() || send.isPending} onClick={submit}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
