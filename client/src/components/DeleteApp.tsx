/**
 * "Delete this app" — the only route back to the survey.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It does not delete on one tap. It opens, then wants the word DELETE
 *    typed. This is the single destructive control in the app and the thing
 *    behind it is months of an athlete's training history.
 *  - It does not erase that history by default. What always goes is the
 *    BLUEPRINT — goals, preferences, the survey answers, the coach transcript,
 *    any stored Garmin/Whoop credentials — because leaving any of it behind
 *    would mean the app you rebuild is still partly the old one. What the
 *    athlete DID is opt-in, behind its own switch, and keeping it is also the
 *    better app: the rebuilt one starts from real numbers instead of seeds.
 *  - It does not claim more than it did. The result says how many rows went,
 *    from the server's own count.
 *
 * See server/surveyService.ts for the tables in each group.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";

export default function DeleteApp() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [eraseHistory, setEraseHistory] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.deleteApp(eraseHistory),
    onSuccess: () => {
      /*
       * A full reload rather than a cache invalidation.
       *
       * Every query in memory — the plan, the shell, the athlete's numbers —
       * describes an app that no longer exists, and `queryClient.clear()`
       * removes those queries out from under the observers still mounted on
       * them, which leaves the old app on screen with no data and no refetch
       * in flight. Verified: the delete succeeded, the server reported no
       * build state, and the browser sat on the settings page.
       *
       * This is also the one moment in the app where restarting from nothing
       * is the honest thing to do. `assign` rather than `replace`, so Back
       * still behaves.
       */
      window.location.assign("/");
    },
  });

  if (!open) {
    return (
      <div className="panel danger-panel">
        <div className="row">
          <div className="stack" style={{ gap: 3 }}>
            <strong>Delete this app</strong>
            <span className="tiny muted">Starts the survey again from scratch and builds you a different one.</span>
          </div>
          <button type="button" className="btn-danger" onClick={() => setOpen(true)}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel danger-panel">
      <div className="section-label" style={{ color: "var(--danger)", marginBottom: 10 }}>
        Delete this app
      </div>

      <p className="small" style={{ marginTop: 0, lineHeight: 1.6 }}>
        Your goals, your settings, the coach conversation and any connected accounts go. You'll be taken
        back to the survey and the app gets rebuilt around whatever you say next.
      </p>

      <label className="check-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={eraseHistory} onChange={(e) => setEraseHistory(e.target.checked)} />
        <span>
          Also erase everything I've <strong>done</strong>
          <span className="tiny muted" style={{ display: "block", marginTop: 2 }}>
            Sessions, tick-offs, weigh-ins, check-ins, injuries, past predictions. Can't be undone, and
            keeping it means the new app starts from your real numbers.
          </span>
        </span>
      </label>

      <label className="field" style={{ marginTop: 14 }}>
        <span className="section-label">Type DELETE to confirm</span>
        <input value={confirm} placeholder="DELETE" autoCapitalize="characters" onChange={(e) => setConfirm(e.target.value)} />
      </label>

      {remove.error && <div className="notice notice-danger">{(remove.error as Error).message}</div>}

      <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
        <button
          type="button"
          className="btn-danger"
          disabled={confirm.trim().toUpperCase() !== "DELETE" || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? "Deleting…" : eraseHistory ? "Delete everything" : "Delete this app"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={remove.isPending}
          onClick={() => {
            setOpen(false);
            setConfirm("");
            setEraseHistory(false);
          }}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
