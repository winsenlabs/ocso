import type { RenderedEmail } from '../contract.js';
import { coarseIp, formatDateTime, formatExpiry, oneLine } from './escape.js';
import { renderLayout, type EmailBlock } from './layout.js';

/**
 * Account emails used by authentication (invites, password reset, email
 * verification, sign-in codes, security notices). Inputs are plain values;
 * every interpolation is escaped by the layout, links must be http(s).
 */
export interface TemplateContext {
  /** Organization name from deployment settings. */
  org: string;
  /** IANA time zone for absolute times (deployment settings); default UTC. */
  timeZone?: string | undefined;
  /** Clock for relative expiry ("in 15 minutes"); default now. */
  now?: Date | undefined;
}

const greeting = (name: string | null | undefined): EmailBlock => ({ kind: 'text', text: name ? `Hi ${oneLine(name, 80)},` : 'Hello,' });
const expiry = (ctx: TemplateContext, at: Date): string => formatExpiry(at, ctx.now ?? new Date(), ctx.timeZone);

export interface InviteEmailInput extends TemplateContext {
  inviterName: string;
  recipientEmail: string;
  recipientName?: string | null | undefined;
  /** Human role name, e.g. "CS Lead". */
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}

export function inviteEmail(input: InviteEmailInput): RenderedEmail {
  const inviter = oneLine(input.inviterName, 80);
  return renderLayout({
    org: input.org,
    subject: `${inviter} invited you to ${input.org} on OCSO`,
    heading: `Join ${input.org} on OCSO`,
    preheader: `${inviter} invited you to join as ${input.roleLabel}.`,
    blocks: [
      greeting(input.recipientName),
      { kind: 'text', text: `${inviter} invited you (${input.recipientEmail}) to join ${input.org} on OCSO as ${input.roleLabel}.` },
      { kind: 'button', label: 'Accept invitation', url: input.acceptUrl },
      { kind: 'note', text: `This invitation expires ${expiry(input, input.expiresAt)}. If you were not expecting it, you can ignore this email.` },
    ],
  });
}

export interface PasswordResetEmailInput extends TemplateContext {
  recipientName?: string | null | undefined;
  resetUrl: string;
  expiresAt: Date;
}

export function passwordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  return renderLayout({
    org: input.org,
    subject: 'Reset your OCSO password',
    heading: 'Reset your password',
    preheader: 'Use this link to choose a new password.',
    blocks: [
      greeting(input.recipientName),
      { kind: 'text', text: `We received a request to reset the password of your OCSO account at ${input.org}.` },
      { kind: 'button', label: 'Choose a new password', url: input.resetUrl },
      { kind: 'note', text: `The link expires ${expiry(input, input.expiresAt)} and works once.` },
      { kind: 'note', text: 'If you did not ask for this, ignore this email. Your password stays the same.' },
    ],
  });
}

export interface EmailVerificationEmailInput extends TemplateContext {
  recipientEmail: string;
  recipientName?: string | null | undefined;
  verifyUrl: string;
  expiresAt?: Date | null | undefined;
}

export function emailVerificationEmail(input: EmailVerificationEmailInput): RenderedEmail {
  return renderLayout({
    org: input.org,
    subject: 'Verify your email address for OCSO',
    heading: 'Verify your email address',
    preheader: `Confirm ${input.recipientEmail} for your OCSO account.`,
    blocks: [
      greeting(input.recipientName),
      { kind: 'text', text: `Confirm that ${input.recipientEmail} is your address to finish setting up your OCSO account at ${input.org}.` },
      { kind: 'button', label: 'Verify email address', url: input.verifyUrl },
      ...(input.expiresAt ? [{ kind: 'note', text: `The link expires ${expiry(input, input.expiresAt)}.` } as const] : []),
      { kind: 'note', text: 'If you did not expect this, ignore this email.' },
    ],
  });
}

export interface SignInCodeEmailInput extends TemplateContext {
  /** One-time code; shown verbatim, never put in the subject or preview. */
  code: string;
  expiresAt: Date;
}

export function signInCodeEmail(input: SignInCodeEmailInput): RenderedEmail {
  return renderLayout({
    org: input.org,
    subject: 'Your OCSO sign-in code',
    heading: 'Your sign-in code',
    preheader: 'Use the code in this email to finish signing in.',
    blocks: [
      { kind: 'text', text: `Enter this code to sign in to OCSO at ${input.org}:` },
      { kind: 'code', code: oneLine(input.code, 32) },
      { kind: 'note', text: `The code expires ${expiry(input, input.expiresAt)} and works once. Never share it — nobody from ${input.org} or OCSO will ask you for it.` },
      { kind: 'note', text: 'If you did not try to sign in, you can ignore this email. Nobody can sign in without the code.' },
    ],
  });
}

export interface PasswordChangedEmailInput extends TemplateContext {
  recipientName?: string | null | undefined;
  changedAt: Date;
  /** Where to reset the password if the change was not the recipient's doing. */
  resetUrl?: string | null | undefined;
}

export function passwordChangedEmail(input: PasswordChangedEmailInput): RenderedEmail {
  const notYou = input.resetUrl
    ? 'If you did not change it, reset your password now and tell your OCSO administrator.'
    : 'If you did not change it, contact your OCSO administrator right away.';
  return renderLayout({
    org: input.org,
    subject: 'Your OCSO password was changed',
    heading: 'Your password was changed',
    preheader: 'Security notice for your OCSO account.',
    blocks: [
      greeting(input.recipientName),
      { kind: 'text', text: `The password of your OCSO account at ${input.org} was changed on ${formatDateTime(input.changedAt, input.timeZone)}.` },
      { kind: 'text', text: `If this was you, no action is needed. ${notYou}` },
      ...(input.resetUrl ? [{ kind: 'button', label: 'Reset password', url: input.resetUrl } as const] : []),
    ],
  });
}

export interface NewSignInEmailInput extends TemplateContext {
  recipientName?: string | null | undefined;
  at: Date;
  /** Full client IP; only a coarse network (/24, /48) is shown. */
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  /** Where to review sessions / change the password. */
  securityUrl?: string | null | undefined;
}

export function newSignInEmail(input: NewSignInEmailInput): RenderedEmail {
  const rows: Array<readonly [string, string]> = [['Time', formatDateTime(input.at, input.timeZone)]];
  if (input.ipAddress) rows.push(['Network', coarseIp(input.ipAddress)]);
  if (input.userAgent) rows.push(['Device', oneLine(input.userAgent, 120)]);
  return renderLayout({
    org: input.org,
    subject: 'New sign-in to your OCSO account',
    heading: 'New sign-in to your account',
    preheader: 'Security notice for your OCSO account.',
    blocks: [
      greeting(input.recipientName),
      { kind: 'text', text: `Your OCSO account at ${input.org} was just used to sign in.` },
      { kind: 'facts', rows },
      { kind: 'text', text: 'If this was you, no action is needed. If not, change your password now and tell your OCSO administrator.' },
      ...(input.securityUrl ? [{ kind: 'button', label: 'Review account security', url: input.securityUrl } as const] : []),
    ],
  });
}
