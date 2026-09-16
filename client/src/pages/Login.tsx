import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * The gate in front of a deployed instance.
 *
 * Not an account system — one shared password for one athlete (see
 * server/auth.ts). It exists because a hosted TrainU holds a real Garmin
 * password and a full training history behind a URL anyone can guess.
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
    <div className="page" style={{ maxWidth: 380, marginTop: "12vh" }}>
      <div className="page-header">
        <div className="kicker">TrainU</div>
        <h1>Sign in</h1>
      </div>
      <form className="panel" onSubmit={submit}>
        <label>
          <span className="section-label">Password</span>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        {error && <div className="notice notice-danger" style={{ marginTop: 12 }}>{error}</div>}
        <button type="submit" disabled={busy || !password} style={{ marginTop: 14, width: "100%" }}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
