import { AppInner } from './AppInner.js'
import { AppProviders } from './AppProviders.js'
import { MobileApp } from './mobile/MobileApp.js'

const isMobilePath = (pathname: string) => pathname === '/mobile' || pathname.endsWith('/mobile')

export const App = () => (
  <AppProviders>
    {isMobilePath(window.location.pathname) ? <MobileApp /> : <AppInner />}
  </AppProviders>
)
