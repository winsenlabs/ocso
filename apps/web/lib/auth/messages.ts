import type { AuthResult } from './better-auth';

/** Human message for a Better Auth error in forms (never echoes secrets). */
export function authMessage(result: Pick<AuthResult<unknown>, 'status' | 'code' | 'message'>, fallback = 'Something went wrong. Try again.'): string {
  switch (result.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'Invalid email or password';
    case 'TOO_MANY_ATTEMPTS':
    case 'TOO_MANY_REQUESTS':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      return 'That code is not valid. Check your authenticator app and try again.';
    case 'INVALID_TWO_FACTOR_COOKIE':
      return 'Your sign-in expired. Enter your email and password again.';
    case 'INVALID_TOKEN':
      return 'This link is invalid or has expired. Ask for a new one.';
    case 'INVALID_PASSWORD':
      return 'Your current password is not correct.';
    case 'PASSWORD_TOO_WEAK':
    case 'PASSWORD_TOO_SHORT':
      return result.message ?? 'Choose a longer password (at least 12 characters).';
    case 'UNREACHABLE':
      return 'The OCSO API is not reachable.';
    default:
      if (result.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
      return result.message ?? fallback;
  }
}
