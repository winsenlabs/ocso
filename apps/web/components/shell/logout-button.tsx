import { logoutAction } from '@/lib/actions/auth';

/** Sign-out control in the sidebar footer (server action; revokes the API session). */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="icon-btn" title="Sign out" aria-label="Sign out">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M13 14l4-4-4-4M17 10H8" />
        </svg>
      </button>
    </form>
  );
}
