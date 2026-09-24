import { useQuery } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import { api } from "./lib/api";
import { useAppShell } from "./lib/appShell";
import Login from "./pages/Login";
import Survey from "./pages/Survey";
import Plan from "./pages/Plan";
import Goals from "./pages/Goals";
import Athlete from "./pages/Athlete";
import Coach from "./pages/Coach";
import Data from "./pages/Data";
import Blocks from "./pages/Blocks";
import { SURFACE_HREF, NavIcon } from "./components/NavIcon";

export default function App() {
  /*
   * One gate in front of everything, rather than each page handling its own
   * 401. A deployed instance holds a Garmin password and a full training
   * history; a public URL with no gate hands both to anyone who finds it.
   * Locally, with no APP_PASSWORD set, the server reports authenticated and
   * this is invisible.
   */
  const { data: auth, isLoading: checkingAuth, refetch } = useQuery({
    queryKey: ["auth-status"],
    queryFn: api.authStatus,
    retry: false,
    staleTime: 60_000,
  });

  const authenticated = Boolean(auth?.authenticated);

  /*
   * The second gate, and the one that decides whether there is an app at all.
   * Everything TrainU renders is assembled off the goal model, so before the
   * survey has produced one there is nothing to show — you get the survey,
   * every time, until it is finished. Afterwards you never see it again
   * unless you delete the app from "Your app".
   *
   * Server-side (`appBuild.completedAt`) rather than a localStorage flag: a
   * phone that cleared its site data would otherwise be handed the survey on
   * top of a database already full of goals, and finishing it would duplicate
   * every one of them.
   */
  const { data: build, isLoading: checkingBuild, refetch: refetchBuild } = useQuery({
    queryKey: ["build-state"],
    queryFn: api.buildState,
    enabled: authenticated,
    retry: false,
    staleTime: 60_000,
  });

  // A blank frame rather than a spinner: both checks are same-origin and
  // usually resolve in a few milliseconds, and a spinner that flashes for
  // 30ms on every load reads as jank.
  if (checkingAuth) return <div className="boot" />;
  if (auth && !authenticated) return <Login onAuthenticated={() => refetch()} />;
  if (checkingBuild) return <div className="boot" />;
  if (build && !build.complete) return <Survey onBuilt={() => refetchBuild()} />;

  return <Shell />;
}

function Shell() {
  const [location] = useLocation();

  /*
   * The nav is assembled too. Without this, a surface the assembler collapsed
   * still shows as a tab leading to an empty page — which is worse than the
   * fixed five it replaced, because it looks broken rather than plain.
   * Falls back to every surface while loading, so the nav never flickers empty.
   */
  const { data: shell } = useAppShell();
  const nav = (shell?.surfaces ?? Object.keys(SURFACE_HREF).map((id) => ({ id, title: id }))).map((surface) => ({
    id: surface.id,
    href: SURFACE_HREF[surface.id] ?? `/${surface.id}`,
    label: surface.title,
  }));
  // Always last and always present: it's how you change everything above it.
  nav.push({ id: "app", href: "/app", label: "Your app" });

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="logo-mark" aria-hidden="true" />
          TrainU
        </Link>
        <nav className="topnav">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={`topnav-link${location === item.href ? " active" : ""}`}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <Switch>
        <Route path="/" component={Plan} />
        <Route path="/goals" component={Goals} />
        <Route path="/athlete" component={Athlete} />
        <Route path="/coach" component={Coach} />
        <Route path="/data" component={Data} />
        <Route path="/app" component={Blocks} />
        <Route>
          <div className="page">
            <div className="page-header">
              <div className="kicker">404</div>
              <h1 className="display">Nothing here</h1>
            </div>
            <Link href="/" className="btn-primary" style={{ display: "inline-block" }}>
              Back to this week
            </Link>
          </div>
        </Route>
      </Switch>

      {/* Thumb-reachable on a phone, hidden on a wide screen where the top bar carries it. */}
      <nav className="tabbar">
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className={`tab${location === item.href ? " active" : ""}`}>
            <NavIcon id={item.id} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
