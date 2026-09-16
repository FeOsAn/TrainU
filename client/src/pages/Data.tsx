import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const TSB_TONE: Record<string, string> = {
  peak: "notice",
  fresh: "notice",
  neutral: "notice-neutral",
  tired: "notice-warn",
  overreached: "notice-danger",
};

export default function Data() {
  const queryClient = useQueryClient();
  const { data: load } = useQuery({ queryKey: ["training-load"], queryFn: api.trainingLoad });
  const { data: sessions } = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const { data: prefs } = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const { data: calibration } = useQuery({ queryKey: ["calibration"], queryFn: api.calibration });

  const toggleConnector = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.patchConnectors(patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["preferences"] }),
  });

  const sync = useMutation({
    mutationFn: (provider: "garmin" | "whoop") => (provider === "garmin" ? api.syncGarmin() : api.syncWhoop()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["training-load"] });
    },
  });

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">Data</div>
        <h1>Load, sessions & calibration</h1>
      </div>

      {load && (
        <div className="panel">
          <div className="section-label" style={{ marginBottom: 10 }}>
            Training load
          </div>
          <div className={`notice ${TSB_TONE[load.tsbStatus] ?? "notice-neutral"}`}>{load.tsbStatusLabel}</div>
          <div className="grid grid-3">
            {[
              { label: "Fitness (CTL)", value: load.currentCtl },
              { label: "Fatigue (ATL)", value: load.currentAtl },
              { label: "Form (TSB)", value: load.currentTsb },
            ].map((metric) => (
              <div key={metric.label} className="surface-2">
                <div className="tiny muted">{metric.label}</div>
                <div className="display-num" style={{ fontSize: 22, marginTop: 2 }}>
                  {metric.value}
                </div>
              </div>
            ))}
          </div>
          <div className="row tiny muted" style={{ marginTop: 10 }}>
            <span>7-day TSS {load.weeklyTss}</span>
            <span>28-day TSS {load.monthlyTss}</span>
            <span>ACWR {load.acwr}</span>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="section-label" style={{ marginBottom: 10 }}>
          Connectors
        </div>
        {prefs &&
          (
            [
              { key: "garmin", label: "Garmin", syncable: true },
              { key: "whoop", label: "Whoop", syncable: true },
              { key: "appleHealth", label: "Apple Health", syncable: false },
            ] as const
          ).map((connector) => (
            <div key={connector.key} className="surface-2" style={{ marginBottom: 8 }}>
              <div className="row">
                <div className="stack">
                  <strong style={{ fontSize: 14 }}>{connector.label}</strong>
                  <span className="tiny muted">
                    {connector.syncable ? "Needs credentials configured on the server" : "Upload an export.xml from the Health app"}
                  </span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn-ghost"
                    style={{ padding: "5px 10px", fontSize: 11.5 }}
                    onClick={() => toggleConnector.mutate({ [connector.key]: !prefs.connectors[connector.key] })}
                  >
                    {prefs.connectors[connector.key] ? "On" : "Off"}
                  </button>
                  {connector.syncable && (
                    <button
                      className="btn-ghost"
                      style={{ padding: "5px 10px", fontSize: 11.5 }}
                      disabled={sync.isPending}
                      onClick={() => sync.mutate(connector.key as "garmin" | "whoop")}
                    >
                      Sync
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        {sync.data && (
          <div className={`notice ${sync.data.error ? "notice-warn" : ""}`}>
            {sync.data.error ?? `Fetched ${sync.data.fetched}, added ${sync.data.inserted}, skipped ${sync.data.skippedDuplicates} duplicates.`}
          </div>
        )}
      </div>

      {calibration && (
        <div className="panel">
          <div className="section-label" style={{ marginBottom: 10 }}>
            Calibration
          </div>
          <div className="notice notice-neutral">{calibration.note}</div>
          <div className="grid grid-3">
            <div className="surface-2">
              <div className="tiny muted">Resolved</div>
              <div className="display-num" style={{ fontSize: 20, marginTop: 2 }}>
                {calibration.sampleSize}
              </div>
            </div>
            <div className="surface-2">
              <div className="tiny muted">Brier score</div>
              <div className="display-num" style={{ fontSize: 20, marginTop: 2 }}>
                {calibration.brierScore ?? "—"}
              </div>
            </div>
            <div className="surface-2">
              <div className="tiny muted">Band multiplier</div>
              <div className="display-num" style={{ fontSize: 20, marginTop: 2 }}>
                {calibration.recommendedMultiplier}×
              </div>
            </div>
          </div>
          {calibration.buckets.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Input quality</th>
                  <th>N</th>
                  <th>Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {calibration.buckets.map((bucket) => (
                  <tr key={bucket.label}>
                    <td>{bucket.label}</td>
                    <td className="display-num">{bucket.count}</td>
                    <td className="display-num">{Math.round(bucket.accuracy * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="panel">
        <div className="section-label" style={{ marginBottom: 10 }}>
          Recent sessions
        </div>
        {sessions && sessions.length === 0 && (
          <div className="small muted">
            Nothing logged yet — sync a connector, upload a .fit file, or import an Apple Health export.
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Sport</th>
                <th>Duration</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 20).map((session) => (
                <tr key={session.id}>
                  <td className="display-num">{session.date}</td>
                  <td>{session.sport}</td>
                  <td className="display-num">{session.durationMinutes}m</td>
                  <td className="muted tiny">{session.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
