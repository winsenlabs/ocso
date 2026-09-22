import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <AuthCard
        title="Forgot your password?"
        sub="We will email you a link to choose a new one."
        foot={
          <a className="auth-link" href="/login">
            back to sign-in
          </a>
        }
      >
        <ForgotPasswordForm />
      </AuthCard>
    </main>
  );
}
