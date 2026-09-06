import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { api, ApiError, type Operator } from './api'
import { Spinner } from './ui'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/TenantDetail'
import Messages from './pages/Messages'
import Pools from './pages/Pools'
import Abuse from './pages/Abuse'
import Plans from './pages/Plans'
import System from './pages/System'
import Domains from './pages/Domains'
import Health from './pages/Health'
import Ips from './pages/Ips'
import Suppressions from './pages/Suppressions'
import Billing from './pages/Billing'
import Audit from './pages/Audit'
import Users from './pages/Users'
import Operators from './pages/Operators'

export default function App() {
  const [me, setMe] = useState<Operator | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Operator>('/me'))
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setMe(null)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) return <Spinner />
  if (!me) return <Login onDone={refresh} />

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="mark">🛠</span> Mailkong Ops</div>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">◱</span>Overview
          </NavLink>
          <div className="nav-group">Customers</div>
          <NavLink to="/tenants" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">◈</span>Tenants
          </NavLink>
          <NavLink to="/messages" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">⌕</span>Message search
          </NavLink>
          <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">☺</span>Users
          </NavLink>
          <NavLink to="/abuse" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">⚠</span>Abuse queue
          </NavLink>
          <NavLink to="/suppressions" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">⊘</span>Suppressions
          </NavLink>
          <div className="nav-group">Infrastructure</div>
          <NavLink to="/domains" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">◈</span>Domains
          </NavLink>
          <NavLink to="/ips" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">▪</span>Sending IPs
          </NavLink>
          <NavLink to="/pools" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">◇</span>IP pools
          </NavLink>
          <NavLink to="/queues" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">♥</span>Queues &amp; health
          </NavLink>
          <NavLink to="/system" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">⚙</span>System
          </NavLink>
          <div className="nav-group">Business</div>
          <NavLink to="/billing" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">$</span>Billing
          </NavLink>
          <NavLink to="/plans" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">▤</span>Plans
          </NavLink>
          <NavLink to="/audit" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">≡</span>Audit log
          </NavLink>
          <NavLink to="/operators" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic">⚑</span>Operators
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <div style={{ color: 'var(--ink)', fontWeight: 600 }}>{me.email}</div>
          <div>{me.role.toLowerCase().replace('_', ' ')}</div>
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
          <Routes>
            <Route index element={<Overview />} />
            <Route path="tenants" element={<Tenants />} />
            <Route path="tenants/:id" element={<TenantDetail me={me} />} />
            <Route path="messages" element={<Messages />} />
            <Route path="abuse" element={<Abuse />} />
            <Route path="domains" element={<Domains />} />
            <Route path="health" element={<Health />} />
            {/* Spec 9.1 names this /queues; /health is kept as an alias so
                existing bookmarks and the alert emails keep working. */}
            <Route path="queues" element={<Health />} />
            <Route path="ips" element={<Ips me={me} />} />
            <Route path="suppressions" element={<Suppressions me={me} />} />
            <Route path="billing" element={<Billing me={me} />} />
            <Route path="pools" element={<Pools me={me} />} />
            <Route path="plans" element={<Plans />} />
            <Route path="system" element={<System me={me} />} />
            <Route path="users" element={<Users me={me} />} />
            <Route path="operators" element={<Operators me={me} />} />
            <Route path="audit" element={<Audit />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
