import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type Me } from './api'
import { Spinner } from './ui'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Token from './pages/Token'
import Forgot from './pages/Forgot'
import Onboarding from './pages/Onboarding'
import Home from './pages/Home'
import Domains from './pages/Domains'
import Credentials from './pages/Credentials'
import TestSend from './pages/TestSend'
import Activity from './pages/Activity'
import Webhooks from './pages/Webhooks'
import Inbound from './pages/Inbound'
import Suppressions from './pages/Suppressions'
import Usage from './pages/Usage'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/me'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading) return <Spinner />

  // Token landing pages are reachable signed out AND signed in: an invite may
  // arrive while another account is already open in the browser.
  const tokenRoutes = (
    <>
      <Route path="/verify/:token" element={<Token mode="verify" onDone={refresh} />} />
      <Route path="/magic/:token" element={<Token mode="magic" onDone={refresh} />} />
      <Route path="/reset/:token" element={<Token mode="reset" onDone={refresh} />} />
      <Route path="/invite/:token" element={<Token mode="invite" onDone={refresh} />} />
    </>
  )

  if (!me) {
    return (
      <Routes>
        {tokenRoutes}
        <Route path="/signup" element={<Signup onDone={refresh} />} />
        <Route path="/forgot" element={<Forgot mode="reset" />} />
        <Route path="/magic" element={<Forgot mode="magic" />} />
        <Route path="*" element={<Login onDone={refresh} />} />
      </Routes>
    )
  }

  const first = me.tenants[0]
  if (!first) return <div className="auth"><div className="auth-card">No organization on this account.</div></div>

  return (
    <Routes>
      {tokenRoutes}
      <Route path="/t/:tenantId/*" element={<Workspace me={me} refresh={refresh} />} />
      <Route path="*" element={<Navigate to={`/t/${first.id}`} replace />} />
    </Routes>
  )
}

function Workspace({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const { tenantId = '' } = useParams()
  const navigate = useNavigate()
  const tenant = me.tenants.find((t) => t.id === tenantId)

  if (!tenant) return <Navigate to="/" replace />

  // Spec 8.2: onboarding is forced until the first domain verifies. Routing
  // it here rather than per-page means no screen can be reached around it.
  const onboarding = tenant.status === 'PAUSED_PENDING_DOMAIN'

  return (
    <>
      {me.impersonated && (
        <div className="impersonation-bar">
          You are viewing this account as {me.user.email}. Actions are recorded against your operator account.
        </div>
      )}
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="mark">✦</span> Mailkong
          </div>

          <nav className="nav">
            <Item to={`/t/${tenantId}`} icon="◱" end>Overview</Item>
            <div className="nav-group">Sending</div>
            <Item to={`/t/${tenantId}/domains`} icon="◈">Domains</Item>
            <Item to={`/t/${tenantId}/credentials`} icon="⚿">Credentials</Item>
            <Item to={`/t/${tenantId}/send`} icon="↗">Test send</Item>
            <Item to={`/t/${tenantId}/activity`} icon="≡">Activity</Item>
            <Item to={`/t/${tenantId}/analytics`} icon="◔">Analytics</Item>
            <div className="nav-group">Integrations</div>
            <Item to={`/t/${tenantId}/webhooks`} icon="⚡">Webhooks</Item>
            <Item to={`/t/${tenantId}/inbound`} icon="↩">Inbound</Item>
            <Item to={`/t/${tenantId}/suppressions`} icon="⊘">Suppressions</Item>
            <div className="nav-group">Account</div>
            <Item to={`/t/${tenantId}/usage`} icon="◷">Usage &amp; billing</Item>
            <Item to={`/t/${tenantId}/settings`} icon="⚙">Settings</Item>
          </nav>

          <div className="sidebar-foot">
            <div style={{ color: 'var(--ink)', fontWeight: 600 }}>{tenant.name}</div>
            <div>{me.user.email}</div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
              onClick={async () => {
                await api.post('/auth/logout')
                await refresh()
                navigate('/')
              }}
            >
              Sign out
            </button>
          </div>
        </aside>

        <div className="main">
          <div className="content">
            {onboarding ? (
              <Onboarding tenantId={tenantId} onVerified={refresh} />
            ) : (
              <Routes>
                <Route index element={<Home tenantId={tenantId} />} />
                <Route path="domains" element={<Domains tenantId={tenantId} />} />
                <Route path="credentials" element={<Credentials tenantId={tenantId} />} />
                <Route path="send" element={<TestSend tenantId={tenantId} />} />
                <Route path="activity" element={<Activity tenantId={tenantId} />} />
                <Route path="analytics" element={<Analytics tenantId={tenantId} />} />
                <Route path="webhooks" element={<Webhooks tenantId={tenantId} />} />
                <Route path="inbound" element={<Inbound tenantId={tenantId} />} />
                <Route path="suppressions" element={<Suppressions tenantId={tenantId} />} />
                <Route path="usage" element={<Usage tenantId={tenantId} />} />
                <Route path="settings" element={<Settings tenantId={tenantId} role={tenant.role} />} />
              </Routes>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Item({ to, icon, children, end }: { to: string; icon: string; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span className="ic">{icon}</span>
      {children}
    </NavLink>
  )
}
