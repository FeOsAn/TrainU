import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * The gate in front of a deployed instance.
 *
 * Not an account system — one shared password for one athlete (see
 * server/auth.ts). It exists because a hosted TrainU holds a real Garmin
 * password and a full training history behind a URL anyone can guess.
 *
 * Locally, with no APP_PASSWORD set, this never renders: the server reports
 * authenticated and App.tsx goes straight to the survey or the plan.
 */
export default function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      queryClient.clear();
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="survey">
      <div className="gate">
        <div className="survey-brand" style={{ fontSize: 19, marginBottom: 30 }}>
          <span className="logo-mark" style={{ width: 26, height: 26, borderRadius: 9 }} aria-hidden="true" />
          TrainU
        </div>

        <h1 className="display">One plan,<br />all your goals.</h1>
        <p className="lede">A race and a wedding six weeks apart don't have to fight. Sign in to pick up where you left off.</p>

        <form className="panel" onSubmit={submit}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="section-label">Password</span>
            <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </label>
          {error && <div className="notice notice-danger" style={{ margin: "14px 0 0" }}>{error}</div>}
          <button type="submit" className="btn-primary btn-lg" disabled={busy || !password} style={{ marginTop: 16, width: "100%" }}>
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
