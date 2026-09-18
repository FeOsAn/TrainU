import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatPace } from "../lib/api";
import { orderByBlocks, useSurfaceBlocks } from "../lib/appShell";
import { BenchmarksPanel } from "../components/BenchmarksPanel";
import { PhysiquePanel } from "../components/PhysiquePanel";
import { ConditionHistory } from "../components/ConditionHistory";
import type { AthleteParams } from "@shared/athlete";

type ScalarKey = Exclude<keyof AthleteParams, "benchmarks">;

interface FieldSpec {
  key: ScalarKey;
  label: string;
  format?: (n: number) => string;
}

/**
 * A group is either a list of `Measured<T>` scalars or a panel of its own.
 * Both are BLOCKS and both go through `orderByBlocks`, so the assembler
 * places station benchmarks, weigh-ins and injury history exactly the way it
 * already places the running and strength numbers — one matching rule, not a
 * second one bolted on for the Phase 10 panels.
 */
interface Group {
  blockId: string;
  title: string;
  /** Scalars from `AthleteParams`; counted by the seed counter. */
  fields?: FieldSpec[];
  /** A panel that carries its own provenance and its own writes. */
  render?: () => ReactNode;
  blurb?: string;
}

/*
 * Each group is a BLOCK — see shared/appShell/blocks.ts. The assembler
 * decides which of these an athlete sees, so a body-composition athlete isn't
 * asked to care about CdA and critical swim speed, and a marathoner isn't
 * either. The ids here have to match the catalog's.
 */
const GROUPS: Group[] = [
  {
    blockId: "athlete.running",
    title: "Running",
    fields: [
      { key: "runThresholdSecPerKm", label: "Fresh kilometre", format: formatPace },
      { key: "run5kSecPerKm", label: "5 km pace", format: formatPace },
      { key: "runEasySecPerKm", label: "Easy pace", format: formatPace },
      { key: "marathonPbMinutes", label: "Marathon PB", format: (n) => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}` },
    ],
  },
  {
    blockId: "athlete.bikeSwim",
    title: "Bike & swim",
    fields: [
      { key: "ftpWatts", label: "FTP", format: (n) => `${n} W` },
      { key: "bikeCdA", label: "Aero drag area (CdA)", format: (n) => `${n} m²` },
      { key: "cssSecPer100m", label: "Critical swim speed", format: (n) => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}/100m` },
    ],
  },
  {
    blockId: "athlete.heartRate",
    title: "Heart rate",
    fields: [
      { key: "lthrBpm", label: "Threshold HR", format: (n) => `${n} bpm` },
      { key: "maxHrBpm", label: "Max HR", format: (n) => `${n} bpm` },
    ],
  },
  {
    blockId: "athlete.body",
    title: "Body",
    fields: [
      { key: "weightKg", label: "Weight", format: (n) => `${n} kg` },
      { key: "bodyFatPercent", label: "Body fat", format: (n) => `${n}%` },
      { key: "heightCm", label: "Height", format: (n) => `${n} cm` },
      { key: "ageYears", label: "Age", format: (n) => `${n}` },
    ],
  },
  {
    blockId: "athlete.strength",
    title: "Strength",
    fields: [
      { key: "squat1RmKg", label: "Squat 1RM", format: (n) => `${n} kg` },
      { key: "deadlift1RmKg", label: "Deadlift 1RM", format: (n) => `${n} kg` },
      { key: "bench1RmKg", label: "Bench 1RM", format: (n) => `${n} kg` },
      { key: "ohp1RmKg", label: "OHP 1RM", format: (n) => `${n} kg` },
      { key: "strengthEnduranceIndex", label: "Strength-endurance index", format: (n) => `${n}` },
    ],
  },
  {
    blockId: "athlete.stations",
    title: "HYROX stations",
    blurb: "Time each one fresh. The predictor applies its own in-race fade on top, so these are gym numbers, not race numbers.",
    render: () => <BenchmarksPanel />,
  },
  {
    blockId: "athlete.physique",
    title: "Physique progress",
    blurb: "The trend, not one morning's number. The newest weigh-in is what the plan reads, so deleting or back-dating one just works.",
    render: () => <PhysiquePanel />,
  },
  {
    blockId: "athlete.conditions",
    title: "Injuries & illness",
    render: () => <ConditionHistory />,
  },
];

function Field({ spec, athlete, onSave }: { spec: FieldSpec; athlete: AthleteParams; onSave: (key: ScalarKey, value: number) => void }) {
  const measured = athlete[spec.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(measured.value));

  return (
    <div className="surface-2" style={{ marginBottom: 8 }}>
      <div className="row">
        <div className="stack" style={{ minWidth: 0 }}>
          <span className="tiny muted">{spec.label}</span>
          {editing ? (
            <input
              autoFocus
              type="number"
              step="any"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const n = parseFloat(draft);
                  if (Number.isFinite(n)) onSave(spec.key, n);
                  setEditing(false);
                }
                if (e.key === "Escape") setEditing(false);
              }}
              style={{ marginTop: 3 }}
            />
          ) : (
            <span className="display-num" style={{ fontSize: 17 }}>
              {spec.format ? spec.format(measured.value) : measured.value}
            </span>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span className={`pill ${measured.verified ? "pill-verified" : "pill-seed"}`}>{measured.verified ? "measured" : "seed"}</span>
          {!editing && (
            <button
              className="btn-ghost"
              style={{ padding: "4px 9px", fontSize: 11, marginLeft: 6 }}
              onClick={() => {
                setDraft(String(measured.value));
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
        {measured.source}
        {measured.asOf ? ` · ${measured.asOf.slice(0, 10)}` : ""}
      </div>
    </div>
  );
}

export default function Athlete() {
  const queryClient = useQueryClient();
  const { data: athlete, isLoading, error } = useQuery({ queryKey: ["athlete"], queryFn: api.athlete });

  const save = useMutation({
    mutationFn: (fields: Record<string, number>) => api.patchAthlete(fields),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["athlete"] });
      queryClient.invalidateQueries({ queryKey: ["plan"] });
    },
  });

  const blocks = useSurfaceBlocks("athlete");
  const groups = orderByBlocks(GROUPS, blocks);

  // Counted over the VISIBLE fields only. Telling a marathoner that 14 of
  // their numbers are seeds, when 5 of those are bike and swim fields this
  // app has decided not to show them, sends them looking for measurements
  // nothing is going to ask for.
  const seedCount = athlete
    ? groups.flatMap((group) => group.fields ?? []).filter((spec) => !athlete[spec.key].verified).length
    : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">Athlete</div>
        <h1>Your numbers, and where they came from</h1>
      </div>

      <div className="notice notice-neutral">
        Every number here carries its own provenance. A <strong>seed</strong> is a guess the app hasn't
        measured yet — it still gets used, but every prediction built on it widens its confidence band to
        say so, instead of quoting a guess with the same certainty as a real test.
      </div>

      {isLoading && <div className="panel"><div className="skeleton" style={{ width: "40%" }} /></div>}
      {error && <div className="notice notice-danger">{(error as Error).message}</div>}
      {save.error && <div className="notice notice-danger">{(save.error as Error).message}</div>}

      {athlete && seedCount > 0 && (
        <div className="notice notice-warn">
          <span className="display-num">{seedCount}</span> of your numbers are still seeds. The fastest way
          to tighten every prediction in the app is to replace the ones that matter for your goals.
        </div>
      )}

      {athlete &&
        groups.map((group) => (
          <div key={group.blockId} className="panel">
            <div className="section-label" style={{ marginBottom: group.blurb ? 6 : 10 }}>
              {group.title}
            </div>
            {group.blurb && <p className="tiny muted" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>{group.blurb}</p>}
            {group.fields?.map((spec) => (
              <Field key={spec.key} spec={spec} athlete={athlete} onSave={(key, value) => save.mutate({ [key]: value })} />
            ))}
            {group.render?.()}
          </div>
        ))}
    </div>
  );
}
