import { DEMO_URL, DOCS_URL, REPO_URL } from '@/lib/site';
import { Icon } from './icons';

/** The three calls to action, in the same order everywhere. */
export function Ctas({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className={`ctas${inverse ? ' ctas-inverse' : ''}`}>
      <a className="btn btn-primary" href={DEMO_URL}>
        Try the demo
        <Icon name="arrow" size={18} />
      </a>
      <a className="btn btn-secondary" href={REPO_URL}>
        <Icon name="github" size={18} />
        View on GitHub
      </a>
      <a className="btn btn-link" href={DOCS_URL}>
        Read the docs
      </a>
    </div>
  );
}
