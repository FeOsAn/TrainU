import { useQuery } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import { api } from "./lib/api";
import { useAppShell } from "./lib/appShell";
import Login from "./pages/Login";
import Plan from "./pages/Plan";
import Goals from "./pages/Goals";
import Athlete from "./pages/Athlete";
import Coach from "./pages/Coach";
import Data from "./pages/Data";
import Blocks from "./pages/Blocks";

/** Where each assembled surface lives. Routes stay registered either way — a surface that collapsed is still reachable by URL, just not advertised. */
const SURFACE_HREF: Record<string, string> = {
  plan: "/",
  goals: "/goals",
  athlete: "/athlete",
  coach: "/coach",
  data: "/data",
};

export default function App() {
  const [location] = useLocation();

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

  if (checkingAuth) return <div className="page" />;
  if (auth && !auth.authenticated) return <Login onAuthenticated={() => refetch()} />;

  return <Shell location={location} />;
}

function Shell({ location }: { location: string }) {
  /*
   * The nav is assembled too. Without this, a surface the assembler collapsed
   * still shows as a tab leading to an empty page — which is worse than the
   * fixed five it replaced, because it looks broken rather than plain.
   * Falls back to every surface while loading, so the nav never flickers empty.
   */
  const { data: shell } = useAppShell();
  const nav = (shell?.surfaces ?? Object.keys(SURFACE_HREF).map((id) => ({ id, title: id }))).map((surface) => ({
    href: SURFACE_HREF[surface.id] ?? `/${surface.id}`,
    label: surface.title,
  }));
  // Always last and always present: it's how you change everything above it.
  nav.push({ href: "/app", label: "Your app" });

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">TrainU</div>
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className={`nav-link${location === item.href ? " active" : ""}`}>
            {item.label}
          </Link>
        ))}
      </nav>

      <Switch>
        <Route path="/" component={Plan} />
        <Route path="/goals" component={Goals} />
        <Route path="/athlete" component={Athlete} />
        <Route path="/coach" component={Coach} />
        <Route path="/data" component={Data} />
        <Route path="/app" component={Blocks} />
        <Route>
          <div className="page">
            <h1>Not found</h1>
          </div>
        </Route>
      </Switch>
    </div>
  );
}
