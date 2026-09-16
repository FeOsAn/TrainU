import { Link, Route, Switch, useLocation } from "wouter";
import Plan from "./pages/Plan";
import Goals from "./pages/Goals";
import Athlete from "./pages/Athlete";
import Coach from "./pages/Coach";
import Data from "./pages/Data";

const NAV = [
  { href: "/", label: "Plan" },
  { href: "/goals", label: "Goals" },
  { href: "/athlete", label: "Athlete" },
  { href: "/coach", label: "Coach" },
  { href: "/data", label: "Data" },
];

export default function App() {
  const [location] = useLocation();

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">TrainU</div>
        {NAV.map((item) => (
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
        <Route>
          <div className="page">
            <h1>Not found</h1>
          </div>
        </Route>
      </Switch>
    </div>
  );
}
