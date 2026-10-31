import { Navigate, Route, Routes } from "react-router-dom";
import { AccountMenu, NoAccess, SignIn } from "./desk/Access.jsx";
import AmcPage from "./desk/AmcPage.jsx";
import ComplaintsPage from "./desk/ComplaintsPage.jsx";
import CustomersPage from "./desk/CustomersPage.jsx";
import Shell from "./desk/Shell.jsx";
import TeamPage from "./desk/TeamPage.jsx";
import { useAuthUser, useMembership } from "./desk/session.js";

// Service Desk: sign in (workspace login) → this app's member list decides access → the team's
// shared complaints, customers and AMCs. The first person to sign in becomes its admin.

function Centered({ children }: { children: string }) {
  return (
    <main className="auth-page">
      <p className="auth-note">{children}</p>
    </main>
  );
}

function App() {
  const auth = useAuthUser();
  const membership = useMembership(auth.user?.id);

  if (auth.loading) return <Centered>Loading…</Centered>;
  if (!auth.user) return <SignIn />;
  if (membership.isLoading) return <Centered>Opening Service Desk…</Centered>;
  if (membership.error) return <Centered>{`Couldn't open Service Desk: ${membership.error.message}`}</Centered>;

  const member = membership.data;
  if (!member || member.status !== "active") return <NoAccess email={auth.user.email} disabled={member?.status === "disabled"} />;

  const accountMenu = <AccountMenu member={member} />;
  return (
    <Routes>
      <Route path="/" element={<Shell accountMenu={accountMenu}><ComplaintsPage /></Shell>} />
      <Route path="/customers" element={<Shell accountMenu={accountMenu}><CustomersPage /></Shell>} />
      <Route path="/amc" element={<Shell accountMenu={accountMenu}><AmcPage /></Shell>} />
      <Route path="/team" element={member.role === "admin" ? <TeamPage me={member} accountMenu={accountMenu} /> : <Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
