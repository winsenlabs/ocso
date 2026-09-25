import { REPO_URL, SECTIONS } from '@/lib/site';
import { Logo } from './brand';
import { Icon } from './icons';

export function Header() {
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <a className="home-link" href="/" aria-label="OCSO home">
          <Logo />
        </a>
        <nav aria-label="Sections" className="header-nav">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`/#${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="btn btn-ghost btn-sm" href={REPO_URL}>
          <Icon name="github" size={18} />
          <span>GitHub</span>
        </a>
      </div>
    </header>
  );
}
