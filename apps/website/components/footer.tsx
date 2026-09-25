import { DEMO_URL, DOCS_URL, REPO_URL, repo } from '@/lib/site';
import { Logo } from './brand';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div className="footer-brand">
          <Logo />
          <p>One Customer Success Orchestrator. Open source under the Apache License 2.0.</p>
        </div>
        <nav aria-label="Footer">
          <ul>
            <li>
              <a href={REPO_URL}>GitHub</a>
            </li>
            <li>
              <a href={DOCS_URL}>Documentation</a>
            </li>
            <li>
              <a href={DEMO_URL}>Demo</a>
            </li>
            <li>
              <a href={repo('SECURITY.md')}>Security policy</a>
            </li>
            <li>
              <a href={repo('LICENSE')}>License</a>
            </li>
          </ul>
        </nav>
        <p className="footer-legal">© 2026 Winsen Labs. Geist is used under the SIL Open Font License 1.1.</p>
      </div>
    </footer>
  );
}
